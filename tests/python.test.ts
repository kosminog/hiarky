import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/analyze';
import { analyzePythonMany, pythonCommand } from '../src/extractors/python';
import { linkSymbols } from '../src/resolve';
import { analyzeProject } from '../src/snap';
import { edgesOf, SymbolInfo } from '../src/types';
import { cleanup, makeProject } from './helpers';

const HAS_PYTHON = pythonCommand() !== null;

const SERVE = `import os
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .model import ArtifactClassifier

__all__ = ["app", "classify"]


class ClassifyRequest(BaseModel):
    content: str = Field(min_length=1)
    limit: int = 10


app = FastAPI(title="Classifier")

_CACHE_SIZE = 1


@lru_cache(maxsize=1)
def get_classifier() -> ArtifactClassifier:
    return ArtifactClassifier(os.environ["DIR"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/classify")
async def classify(request: ClassifyRequest, verbose: bool = False) -> dict:
    return get_classifier().classify(request.content)
`;

const MODEL = `class ArtifactClassifier:
    def __init__(self, model_dir: str) -> None:
        self.model_dir = model_dir

    def classify(self, content: str) -> dict:
        return {"type": "resume"}


def model_kwargs() -> dict:
    return {}


def _private_helper():
    return 1
`;

const FLASK = `from flask import Flask

app = Flask(__name__)


@app.route("/items", methods=["POST", "GET"])
def create_item():
    return ""
`;

let root: string;
const analyze = (rel: string) => analyzeFile(path.join(root, rel), rel);
const byName = (symbols: SymbolInfo[], name: string) => {
  const s = symbols.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name} in [${symbols.map((x) => x.name)}]`);
  return s;
};

beforeAll(() => {
  root = makeProject({
    'svc/serve.py': SERVE,
    'svc/model.py': MODEL,
    'svc/flask_app.py': FLASK,
    'svc/broken.py': 'def oops(:\n',
  });
});

afterAll(() => cleanup(root));

describe.skipIf(!HAS_PYTHON)('python extractor', () => {
  it('records module-level functions, classes, and constants', () => {
    const { symbols } = analyze('svc/model.py');
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'class:ArtifactClassifier',
      'function:model_kwargs',
      'function:_private_helper',
    ]);
  });

  it('captures annotated signatures', () => {
    expect(byName(analyze('svc/model.py').symbols, 'model_kwargs').signature).toBe('() -> dict');
    expect(byName(analyze('svc/serve.py').symbols, 'classify').signature).toBe(
      '(request: ClassifyRequest, verbose: bool = False) -> dict'
    );
  });

  it('records class members and base classes', () => {
    const cls = byName(analyze('svc/model.py').symbols, 'ArtifactClassifier');
    expect(cls.members).toEqual(['classify']);
    const request = byName(analyze('svc/serve.py').symbols, 'ClassifyRequest');
    expect(request.members).toEqual(['content: str', 'limit: int']);
    expect(edgesOf(request, 'extends').map((e) => e.name)).toEqual(['BaseModel']);
    expect(request.role).toContain('schema');
  });

  it('turns FastAPI decorators into routes', () => {
    const symbols = analyze('svc/serve.py').symbols;
    expect(byName(symbols, 'health')).toMatchObject({ kind: 'route', route: 'GET /health' });
    expect(byName(symbols, 'classify')).toMatchObject({
      kind: 'route',
      route: 'POST /classify',
    });
  });

  it('handles Flask route decorators with a methods list', () => {
    expect(byName(analyze('svc/flask_app.py').symbols, 'create_item')).toMatchObject({
      kind: 'route',
      route: 'POST /items',
    });
  });

  it('does not count decorators as calls from the body', () => {
    const health = byName(analyze('svc/serve.py').symbols, 'health');
    expect(edgesOf(health, 'calls').map((e) => e.name)).not.toContain('app.get');
  });

  it('records other decorators as roles', () => {
    expect(byName(analyze('svc/serve.py').symbols, 'get_classifier').role).toContain('lru_cache');
    expect(byName(analyze('svc/serve.py').symbols, 'classify').role).toContain('async');
  });

  it('reads visibility from __all__, falling back to the underscore convention', () => {
    const serve = analyze('svc/serve.py').symbols;
    expect(byName(serve, 'app').export).toBe('named');
    expect(byName(serve, 'classify').export).toBe('named');
    // present in the module but not in __all__
    expect(byName(serve, 'health').export).toBe('none');
    expect(byName(serve, '_CACHE_SIZE').export).toBe('none');

    const model = analyze('svc/model.py').symbols;
    expect(byName(model, 'model_kwargs').export).toBe('named');
    expect(byName(model, '_private_helper').export).toBe('none');
  });

  it('translates relative imports into resolvable specifiers', () => {
    expect(analyze('svc/serve.py').imports).toContainEqual({
      local: 'ArtifactClassifier',
      imported: 'ArtifactClassifier',
      source: './model',
    });
  });

  it('links a call across python modules', () => {
    const analyses = ['svc/serve.py', 'svc/model.py'].map(analyze);
    const { symbols } = linkSymbols(root, analyses);
    const target = edgesOf(byName(symbols, 'get_classifier'), 'calls').find(
      (e) => e.name === 'ArtifactClassifier'
    );
    expect(target?.id).toBe('svc/model.py#ArtifactClassifier');
  });

  it('keeps a file that will not parse, as a hash-only symbol', () => {
    const analysis = analyze('svc/broken.py');
    expect(analysis.parseError).toContain('SyntaxError');
    expect(analysis.symbols).toHaveLength(1);
    expect(analysis.symbols[0]).toMatchObject({ kind: 'module', name: 'broken' });
    expect(analysis.symbols[0].bodyHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('analyzes a batch in one interpreter run, in order', () => {
    const results = analyzePythonMany([
      { abs: path.join(root, 'svc/model.py'), rel: 'svc/model.py' },
      { abs: path.join(root, 'svc/serve.py'), rel: 'svc/serve.py' },
    ]);
    expect(results.map((r) => r.file)).toEqual(['svc/model.py', 'svc/serve.py']);
  });

  it('degrades to a hash-only symbol when a file cannot be read', () => {
    const [result] = analyzePythonMany([
      { abs: path.join(root, 'svc/missing.py'), rel: 'svc/missing.py' },
    ]);
    expect(result.parseError).toBeTruthy();
    expect(result.symbols[0]).toMatchObject({ kind: 'module', name: 'missing' });
  });

  it('shows up in a project scan alongside the other languages', async () => {
    const analysis = await analyzeProject(root);
    const langs = new Set(analysis.symbols.map((s) => s.lang));
    expect(langs.has('py')).toBe(true);
    expect(analysis.errors.some((e) => e.file === 'svc/broken.py')).toBe(true);
  });
});
