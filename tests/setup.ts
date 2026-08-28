import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsArrayBuffer(this);
    });
  };
}

afterEach(() => {
  cleanup();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.unstubAllGlobals();
});
