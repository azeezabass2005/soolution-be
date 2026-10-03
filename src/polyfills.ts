/**
 * Runtime polyfills. Must be imported before anything else in the entry point.
 *
 * Node 26 removed `buffer.SlowBuffer`, but jsonwebtoken → jws → jwa → buffer-equal-constant-time@1.0.1
 * (unmaintained, no fixed release) reads `SlowBuffer.prototype` at load time and crashes the process.
 * `Buffer` is a drop-in for what that package touches.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bufferModule = require("buffer");
if (!bufferModule.SlowBuffer) {
    bufferModule.SlowBuffer = bufferModule.Buffer;
}

export {};
