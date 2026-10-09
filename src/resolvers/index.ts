import Resolver from '@forge/resolver';

const resolver = new Resolver();

resolver.define('getText', () => {
  return 'Hello, world!';
});

export const handler = resolver.getDefinitions();
