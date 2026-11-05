/** Web QA stand-in for expo-file-system's new API (see metro.config.js). */
export * from './expo-file-system-legacy';

export class File {
  constructor(readonly uri: string) {}
  async preview() {}
  get exists() {
    return false;
  }
}

export class Directory {
  constructor(readonly uri: string) {}
}

export const Paths = { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///documents/' } };
