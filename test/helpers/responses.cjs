// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/** Response builders shared by the upstream mock and its fixtures. */

/** Build a Response from whatever a handler returned. */
function toResponse(out) {
  if (out instanceof Response) return out;
  if (out == null) return new Response(null, { status: 204 });
  if (typeof out === 'string') return new Response(out, { status: 200, headers: { 'content-type': 'text/plain' } });
  if (Buffer.isBuffer(out) || out instanceof Uint8Array) return new Response(out, { status: 200 });
  if (out.__response) {
    const { status = 200, headers = {}, body = null } = out;
    return new Response(body, { status, headers });
  }
  return json(out).toResponse();
}

/** Handler result helpers. */
function json(data, { status = 200, headers = {} } = {}) {
  return {
    __response: true, status, body: JSON.stringify(data),
    headers: { 'content-type': 'application/json', ...headers },
    toResponse() { return new Response(this.body, { status, headers: this.headers }); },
  };
}
function text(body, { status = 200, headers = {} } = {}) {
  return { __response: true, status, body, headers: { 'content-type': 'text/plain', ...headers } };
}
function status(code, body = '', headers = {}) {
  return { __response: true, status: code, body, headers };
}
// A valid 1x1 transparent PNG.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');
function png() {
  return { __response: true, status: 200, body: PNG_1PX, headers: { 'content-type': 'image/png' } };
}
/** A handler that never answers, until the caller's AbortSignal fires. */
const HANG = Symbol('hang');


module.exports = { toResponse, json, text, status, png, PNG_1PX, HANG };
