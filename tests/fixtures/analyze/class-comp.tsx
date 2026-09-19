import React from 'react';
import Button from './button';

export class UserCard extends React.Component {
  render() {
    return (
      <div title={this.props.title}>
        <Button label={this.props.label} />
      </div>
    );
  }
}

class Hidden extends React.PureComponent {
  render() {
    return <span>{this.props.x}</span>;
  }
}

export default UserCard;
