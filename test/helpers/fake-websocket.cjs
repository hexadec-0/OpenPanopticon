// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * Stand-in for the global WebSocket the AIS stream uses.
 *
 * The server only ever opens wss://stream.aisstream.io, so this records each
 * socket it creates and lets a test drive it: open it, push messages, fail
 * it, or close it from the "server" side.
 */

class FakeWebSocket {
  static instances = [];

  static get last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] || null; }

  static reset() { FakeWebSocket.instances = []; }

  constructor(url) {
    this.url = url;
    this.readyState = 0;           // CONNECTING
    this.sent = [];
    this.listeners = { open: [], message: [], error: [], close: [] };
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  emit(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }

  /* test controls */
  open() { this.readyState = 1; this.emit('open'); return this; }

  message(obj) { this.emit('message', { data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); return this; }

  fail() { this.emit('error', {}); return this; }

  serverClose() { this.readyState = 3; this.emit('close', { code: 1006 }); return this; }
}

/** An AISStream PositionReport. */
function positionReport(mmsi, { lat, lon, sog = 12.3, cog = 45, heading = 44, nav = 0, classB = false, name } = {}) {
  const type = classB ? 'StandardClassBPositionReport' : 'PositionReport';
  return {
    MessageType: type,
    MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lon },
    Message: { [type]: {
      Latitude: lat, Longitude: lon, Sog: sog, Cog: cog, TrueHeading: heading,
      RateOfTurn: 0, NavigationalStatus: nav,
    } },
  };
}

/** An AISStream ShipStaticData message. */
function staticData(mmsi, { name = 'TEST VESSEL', type = 70, destination = 'TESTPORT', callSign = 'TEST1' } = {}) {
  return {
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: mmsi },
    Message: { ShipStaticData: {
      Name: `${name}   `, CallSign: callSign, ImoNumber: 9876543, Type: type,
      Destination: destination, MaximumStaticDraught: 9.5,
      Dimension: { A: 150, B: 50, C: 15, D: 15 }, Eta: { Month: 10, Day: 22 },
    } },
  };
}

module.exports = { FakeWebSocket, positionReport, staticData };
