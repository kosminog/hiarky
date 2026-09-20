/**
 * The Python side of the Python extractor.
 *
 * Kept as a string and handed to `python3 -c` rather than shipped as a .py
 * file: there is no asset-copying build step to forget, nothing to resolve
 * relative to dist/, and the extractor works the same from source, from a
 * global install, and from a bundle.
 *
 * Contract: argv[1:] are file paths; stdout is a JSON array, one object per
 * file, in the same order.
 */
export const PYTHON_AST_SCRIPT = String.raw`
import ast, hashlib, json, sys

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}
SCHEMA_BASES = ("BaseModel", "TypedDict", "Struct")


def unparse(node):
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def body_hash(text):
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12]


def segment(source, node):
    try:
        return ast.get_source_segment(source, node) or ""
    except Exception:
        return ""


def arg_text(arg):
    ann = unparse(arg.annotation)
    return arg.arg + (": " + ann if ann else "")


def with_default(text, default):
    if default is None:
        return text
    rendered = unparse(default)
    return text + " = " + rendered if rendered is not None else text


def signature(node):
    """Parameters with annotations and defaults: a changed default is a
    behaviour change, so it belongs in the signature."""
    a = node.args
    positional = list(getattr(a, "posonlyargs", [])) + list(a.args)
    # defaults align to the tail of the positional parameters
    pad = len(positional) - len(a.defaults)
    parts = []
    for index, arg in enumerate(positional):
        default = a.defaults[index - pad] if index >= pad else None
        parts.append(with_default(arg_text(arg), default))
    if a.vararg:
        parts.append("*" + arg_text(a.vararg))
    if a.kwonlyargs:
        if not a.vararg:
            parts.append("*")
        for arg, default in zip(a.kwonlyargs, a.kw_defaults):
            parts.append(with_default(arg_text(arg), default))
    if a.kwarg:
        parts.append("**" + arg_text(a.kwarg))
    ret = unparse(node.returns)
    return "(" + ", ".join(parts) + ")" + (" -> " + ret if ret else "")


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        head = dotted(node.value)
        return head + "." + node.attr if head else None
    if isinstance(node, ast.Call):
        return dotted(node.func)
    return None


def decorator_route(decorators):
    """FastAPI/Flask style route decorators, as 'POST /classify' or '/classify'."""
    for dec in decorators:
        target = dec.func if isinstance(dec, ast.Call) else dec
        name = dotted(target) or ""
        tail = name.split(".")[-1]
        path = None
        methods = []
        if isinstance(dec, ast.Call):
            for arg in dec.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    path = arg.value
                    break
            for kw in dec.keywords:
                if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                    methods = [
                        e.value
                        for e in kw.value.elts
                        if isinstance(e, ast.Constant) and isinstance(e.value, str)
                    ]
        if tail in HTTP_METHODS and path:
            return tail.upper() + " " + path
        if tail in ("route", "add_route") and path:
            return (methods[0].upper() + " " + path) if methods else path
    return None


def decorator_nodes(node):
    out = []
    for child in ast.walk(node):
        for dec in getattr(child, "decorator_list", None) or []:
            out.append(dec)
    return out


def collect_calls(node, known):
    """Calls whose head identifier is imported or defined at module level.

    Decorators are skipped: they are already recorded as roles and routes, and
    counting them again would report every handler as calling app.post.
    """
    skip = set()
    for dec in decorator_nodes(node):
        for part in ast.walk(dec):
            skip.add(id(part))
    seen = []
    for child in ast.walk(node):
        if not isinstance(child, ast.Call) or id(child) in skip:
            continue
        name = dotted(child.func)
        if not name:
            continue
        if name.split(".")[0] in known and name not in seen:
            seen.append(name)
    return seen


def class_members(node):
    members = []
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if item.name != "__init__":
                members.append(item.name)
        elif isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
            ann = unparse(item.annotation)
            members.append(item.target.id + (": " + ann if ann else ""))
        elif isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name):
                    members.append(target.id)
    return members


def analyze(path):
    result = {"file": path, "imports": [], "symbols": [], "error": None}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            source = handle.read()
        tree = ast.parse(source)
    except SyntaxError as exc:
        result["error"] = "SyntaxError: " + str(exc)
        return result
    except Exception as exc:
        result["error"] = type(exc).__name__ + ": " + str(exc)
        return result

    imports = []
    known = set()
    exported = None

    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name.split(".")[0]
                imports.append({"local": local, "imported": "*", "source": alias.name})
                known.add(local)
        elif isinstance(node, ast.ImportFrom):
            # Relative imports become path-like so the shared resolver can walk them
            module = node.module or ""
            if node.level:
                source = "." * node.level + module
                prefix = "./" if node.level == 1 else "../" * (node.level - 1)
                spec = prefix + module.replace(".", "/") if module else prefix.rstrip("/") or "."
            else:
                spec = module.replace(".", "/")
            for alias in node.names:
                local = alias.asname or alias.name
                imports.append({"local": local, "imported": alias.name, "source": spec})
                known.add(local)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            known.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    known.add(target.id)
                    if target.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                        exported = [
                            e.value
                            for e in node.value.elts
                            if isinstance(e, ast.Constant) and isinstance(e.value, str)
                        ]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            known.add(node.target.id)

    def visibility(name):
        # __all__ is the explicit statement; otherwise the leading-underscore convention
        if exported is not None:
            return "named" if name in exported else "none"
        return "none" if name.startswith("_") else "named"

    symbols = []

    def add(name, kind, node, **extra):
        entry = {
            "name": name,
            "kind": kind,
            "export": visibility(name),
            "bodyHash": body_hash(segment(source, node)),
            "edges": [],
        }
        entry.update({k: v for k, v in extra.items() if v})
        symbols.append(entry)

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            route = decorator_route(node.decorator_list)
            roles = [dotted(d.func if isinstance(d, ast.Call) else d) or "" for d in node.decorator_list]
            roles = [r.split(".")[-1] for r in roles if r]
            if isinstance(node, ast.AsyncFunctionDef):
                roles.append("async")
            add(
                node.name,
                "route" if route else "function",
                node,
                signature=signature(node),
                route=route,
                role=roles,
                edges=[{"kind": "calls", "name": c} for c in collect_calls(node, known)],
            )
        elif isinstance(node, ast.ClassDef):
            bases = [dotted(b) for b in node.bases]
            bases = [b for b in bases if b]
            roles = ["schema"] if any(b.split(".")[-1] in SCHEMA_BASES for b in bases) else []
            edges = [{"kind": "extends", "name": b} for b in bases if b.split(".")[0] in known]
            edges += [
                {"kind": "calls", "name": c}
                for c in collect_calls(node, known)
            ]
            add(
                node.name,
                "class",
                node,
                members=class_members(node),
                role=roles,
                edges=edges,
            )
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    add(
                        target.id,
                        "const",
                        node,
                        edges=[{"kind": "calls", "name": c} for c in collect_calls(node, known)],
                    )
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            add(node.target.id, "const", node)

    result["imports"] = imports
    result["symbols"] = symbols
    return result


print(json.dumps([analyze(p) for p in sys.argv[1:]]))
`;
