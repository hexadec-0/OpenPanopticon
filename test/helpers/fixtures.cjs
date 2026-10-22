// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * Canned answers for every upstream, shaped like the real APIs.
 *
 * Everything that has a position is placed around HOME (the location the
 * mocked geoIP lookup reports), so the app boots over data it can draw. For
 * upstreams that are queried with a box, a feature lands on HOME when HOME
 * is inside the box and at the box's centre otherwise, so any query gets
 * something back.
 *
 * The data deliberately includes the awkward cases each normaliser is meant
 * to handle: records with no coordinates, duplicates, stale positions,
 * out-of-range bearings, indoor sensors, zone-only alerts and so on.
 */

const { json, text, status, png } = require('./responses.cjs');

const HOME = Object.freeze({
  lat: 35.0, lon: -100.0, city: 'Testville', region: 'Test State', country: 'Testland',
});

/** API keys handed to the server in tests. None may ever reach the browser. */
const TEST_KEYS = Object.freeze({
  SHODAN_API_KEY: 'test-shodan-SECRET-1111',
  WINDY_API_KEY: 'test-windy-SECRET-2222',
  OPENWEBCAMDB_API_KEY: 'test-owcdb-SECRET-3333',
  FIRMS_MAP_KEY: 'test-firms-SECRET-4444',
  AISSTREAM_API_KEY: 'test-ais-SECRET-5555',
  OPENCELLID_API_KEY: 'test-ocid-SECRET-6666',
  WIGLE_API_NAME: 'test-wigle-name',
  WIGLE_API_TOKEN: 'test-wigle-SECRET-7777',
  GREYNOISE_API_KEY: 'test-greynoise-SECRET-8888',
  EIA_API_KEY: 'test-eia-SECRET-9999',
  CLOUDFLARE_API_TOKEN: 'test-cf-SECRET-aaaa',
  CARTO_API_KEY: 'test-carto-SECRET-bbbb',
  OPENSKY_CLIENT_ID: 'test-opensky-id',
  OPENSKY_CLIENT_SECRET: 'test-opensky-SECRET-cccc',
  FIVE_ELEVEN_KEYS: 'GA:test-511ga-SECRET-dddd',
});

const near = (dLat = 0, dLon = 0) => ({ lat: HOME.lat + dLat, lon: HOME.lon + dLon });

function inBox(b, p) {
  return b && p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east;
}

/** HOME (plus an offset) when the box covers it, otherwise the box's centre. */
function place(box, dLat = 0, dLon = 0) {
  const p = near(dLat, dLon);
  if (!box || inBox(box, p)) return p;
  return {
    lat: (box.south + box.north) / 2 + dLat / 10,
    lon: (box.west + box.east) / 2 + dLon / 10,
  };
}

const num = (v) => Number(v);
const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ */
/* Orbital elements                                                    */
/* ------------------------------------------------------------------ */

function tleChecksum(line) {
  let sum = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return line.slice(0, 68) + String(sum % 10);
}

/** YYDDD.DDDDDDDD for "now", so SGP4 propagates from a fresh epoch. */
function tleEpoch(d = new Date()) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const day = (d.getTime() - start) / 86400_000 + 1;
  return `${String(d.getUTCFullYear()).slice(2)}${day.toFixed(8).padStart(12, '0')}`;
}

function tle(name, l1, l2) {
  const epoch = tleEpoch();
  const line1 = tleChecksum(`${l1.slice(0, 18)}${epoch}${l1.slice(32)}`);
  const line2 = tleChecksum(l2);
  if (line1.length !== 69 || line2.length !== 69) throw new Error(`bad TLE fixture for ${name}`);
  return `${name}\n${line1}\n${line2}`;
}

function stationsTle() {
  return [
    tle('ISS (ZARYA)',
      '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005',
      '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537'),
    tle('TEST SAT 2',
      '1 99999U 24999A   24001.50000000  .00001000  00000-0  10000-4 0  9990',
      '2 99999  97.5000 100.0000 0010000  90.0000 270.0000 15.20000000 12345'),
    // A broken record the parser must skip rather than choke on.
    'NOT A SATELLITE\nthis is not a TLE line\nneither is this',
  ].join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Per-upstream builders                                               */
/* ------------------------------------------------------------------ */

function shodanSearch({ params }) {
  const q = params.get('query') || '';
  const m = /geo:"(-?[\d.]+),(-?[\d.]+),(\d+)"/.exec(q);
  const c = m ? { lat: num(m[1]), lon: num(m[2]), r: num(m[3]) } : { ...HOME, r: 10 };
  const d = c.r / 111;
  const box = { south: c.lat - d, north: c.lat + d, west: c.lon - d, east: c.lon + d };
  const p1 = place(box, 0.002, 0.002);
  const p2 = place(box, -0.002, 0.003);
  return json({
    total: 3,
    matches: [
      {
        ip_str: '198.51.100.10', port: 443, transport: 'tcp', org: 'Test Hosting', isp: 'Test ISP',
        asn: 'AS64500', product: 'nginx', version: '1.18.0', os: 'Linux',
        hostnames: ['host.example'], tags: ['cloud'], timestamp: '2026-10-20T12:34:56.000000',
        vulns: { 'CVE-2021-44228': {}, 'CVE-2023-0001': {} },
        data: 'HTTP/1.1 200 OK\r\nServer: nginx/1.18.0\r\n',
        location: { latitude: p1.lat, longitude: p1.lon, city: 'Testville', country_name: 'Testland' },
      },
      {
        ip_str: '198.51.100.11', port: 502, transport: 'tcp', org: 'Test Water Works',
        product: 'Modbus', data: 'Unit ID: 0',
        location: { latitude: p2.lat, longitude: p2.lon, city: 'Testville', country_code: 'TL' },
      },
      // No location: dropped when geolocation is required.
      { ip_str: '198.51.100.12', port: 22, product: 'OpenSSH', location: {} },
    ],
  });
}

function openSkyStates({ params }) {
  const box = {
    south: num(params.get('lamin')), west: num(params.get('lomin')),
    north: num(params.get('lamax')), east: num(params.get('lomax')),
  };
  const t = nowSec();
  const a = place(box, 0.004, -0.004);
  const b = place(box, 0.006, 0.005);
  const g = place(box, -0.003, 0.001);
  return json({
    time: t,
    states: [
      ['a1b2c3', 'TST123  ', 'United States', t - 2, t - 1, a.lon, a.lat, 10000, false, 230, 90, 0, null, 10100, '1200', false, 0, 4],
      ['d4e5f6', 'EMG777  ', 'United States', t - 3, t - 1, b.lon, b.lat, 2500, false, 150, 180, -6, null, 2550, '7700', false, 0, 3],
      ['ffeedd', 'GND1    ', 'United States', t - 1, t - 1, g.lon, g.lat, 0, true, 0, 0, 0, null, null, null, false, 0, 2],
      // Last heard five minutes ago: stale, so dropped from the live set.
      ['0ab0ab', 'OLD9    ', 'Canada', t - 300, t - 300, a.lon, a.lat, 9000, false, 200, 45, 0, null, 9050, '2000', false, 0, 4],
      // No position at all: filtered out before anything else.
      ['112233', 'NOPOS   ', 'Canada', null, t, null, null, null, false, null, null, null, null, null, null, false, 0, 0],
    ],
  }, { headers: { 'x-rate-limit-remaining': '3900' } });
}

function overpass({ body }) {
  const data = new URLSearchParams(String(body || '')).get('data') || '';
  const m = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(data);
  const box = m ? { south: num(m[1]), west: num(m[2]), north: num(m[3]), east: num(m[4]) } : null;
  const p = (dLat, dLon) => place(box, dLat, dLon);

  if (/surveillance:type/.test(data)) {
    const flock = p(0.001, 0.001);
    return json({
      elements: [
        { type: 'node', id: 1001, ...flock, tags: {
          man_made: 'surveillance', 'surveillance:type': 'ALPR', manufacturer: 'Flock Safety',
          operator: 'Testville Police Department', 'operator:type': 'government',
          direction: '90;500', 'camera:mount': 'pole', 'surveillance:zone': 'traffic',
          electricity: 'solar', ref: 'FL-1', image: 'https://images.example/flock1.jpg' } },
        // The same camera returned by a second clause: must be counted once.
        { type: 'node', id: 1001, ...flock, tags: { man_made: 'surveillance', manufacturer: 'Flock Safety' } },
        { type: 'node', id: 1002, ...p(0.002, -0.001), tags: {
          man_made: 'surveillance', 'surveillance:type': 'ALPR', brand: 'Motorola Solutions',
          operator: 'Test County Sheriff', direction: 'NNE' } },
        { type: 'node', id: 1003, ...p(-0.001, 0.002), tags: {
          man_made: 'surveillance', 'surveillance:type': 'ALPR', direction: 'sideways',
          image: 'javascript:alert(1)' } },
        { type: 'way', id: 2001, center: p(0.003, 0.003), tags: {
          'surveillance:type': 'ANPR', manufacturer: 'Genetec AutoVu' } },
        { type: 'node', id: 1004, tags: { 'surveillance:type': 'ALPR' } },   // no geometry
      ],
    });
  }

  return json({
    elements: [
      { type: 'node', id: 3001, ...p(0.001, 0.0), tags: {
        man_made: 'surveillance', 'surveillance:type': 'camera', operator: 'Test Mall', name: 'Mall cam' } },
      { type: 'way', id: 3002, center: p(0.004, 0.002), tags: {
        landuse: 'military', aeroway: 'aerodrome', name: 'Test Air Force Base', icao: 'KTST' } },
      { type: 'node', id: 3003, ...p(-0.002, 0.001), tags: { power: 'substation', voltage: '138000', name: 'Test Substation' } },
      { type: 'node', id: 3004, ...p(0.002, -0.003), tags: { man_made: 'communications_tower', height: '120' } },
      { type: 'node', id: 3005, ...p(0.0, 0.004), tags: { amenity: 'hospital', name: 'Testville General' } },
      { type: 'node', id: 3006, ...p(0.0, 0.005), tags: { amenity: 'cafe', name: 'Not infrastructure' } },
      { type: 'node', id: 3007, tags: { power: 'plant' } },   // no geometry
    ],
  });
}

function atlas({ params }) {
  const box = {
    south: num(params.get('latitude__gte')), north: num(params.get('latitude__lte')),
    west: num(params.get('longitude__gte')), east: num(params.get('longitude__lte')),
  };
  const p = place(box, 0.003, -0.002);
  return json({
    results: [
      { id: 6001, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        description: 'Test probe', asn_v4: 64500, country_code: 'US', status: { name: 'Connected' },
        is_anchor: false, prefix_v4: '198.51.100.0/24', tags: [{ name: 'home' }, { name: 'nat' }],
        first_connected: 1600000000 },
      { id: 6002, geometry: null, description: 'No coordinates' },
    ],
  });
}

function openCellId({ params }) {
  const [s, w, n, e] = String(params.get('BBOX') || '').split(',').map(Number);
  const p = place({ south: s, west: w, north: n, east: e }, -0.001, -0.001);
  return json({ cells: [
    { radio: 'LTE', mcc: 310, mnc: 410, lac: 7, cellid: 12345, lat: p.lat, lon: p.lon,
      range: 1500, samples: 42, averageSignalStrength: -90 },
    { radio: 'GSM', mcc: 310, mnc: 260, lac: 8, cellid: 999, lat: 'x', lon: 'y' },
  ] });
}

function wigle({ params }) {
  const box = {
    south: num(params.get('latrange1')), north: num(params.get('latrange2')),
    west: num(params.get('longrange1')), east: num(params.get('longrange2')),
  };
  const p = place(box, 0.001, 0.002);
  return json({ success: true, results: [
    { netid: '00:11:22:33:44:55', ssid: 'TestNet', trilat: p.lat, trilong: p.lon,
      encryption: 'wpa2', channel: 6, type: 'infra', country: 'US',
      firsttime: '2024-01-01T00:00:00.000Z', lasttime: '2026-10-01T00:00:00.000Z',
      lastupdt: '2026-10-01T00:00:00.000Z', qos: 3 },
    { netid: 'aa:bb:cc:dd:ee:ff', ssid: '', trilat: p.lat + 0.0005, trilong: p.lon, encryption: 'none' },
  ] });
}

function onionoo() {
  return json({ relays: [
    { country: 'us', country_name: 'United States', observed_bandwidth: 10_000_000, flags: ['Exit', 'Guard', 'Running'] },
    { country: 'us', country_name: 'United States', observed_bandwidth: 5_000_000, flags: ['Running'] },
    { country: 'de', country_name: 'Germany', observed_bandwidth: 20_000_000, flags: ['Guard', 'Running'] },
    { country: 'zz', country_name: 'Nowhere', observed_bandwidth: 1, flags: [] },   // no centroid
    { country: '', observed_bandwidth: 1, flags: [] },
  ] });
}

function sensorCommunity({ url }) {
  const m = /box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(url.pathname);
  const box = m ? { south: num(m[1]), west: num(m[2]), north: num(m[3]), east: num(m[4]) } : null;
  const a = place(box, 0.002, 0.002);
  const b = place(box, -0.002, 0.002);
  const c = place(box, 0.0, -0.002);
  const loc = (p, extra = {}) => ({
    latitude: String(p.lat), longitude: String(p.lon), indoor: 0, country: 'US',
    altitude: '300', exact_location: 1, ...extra,
  });
  return json([
    { sensor: { id: 7001, sensor_type: { name: 'SDS011', manufacturer: 'Nova Fitness' } },
      location: loc(a), timestamp: '2026-10-21 10:00:00',
      sensordatavalues: [{ value_type: 'P2', value: '12.5' }, { value_type: 'P1', value: '20.1' }] },
    // Older reading from the same sensor: the newer one above must win.
    { sensor: { id: 7001, sensor_type: { name: 'SDS011' } }, location: loc(a),
      timestamp: '2026-10-21 09:00:00', sensordatavalues: [{ value_type: 'P2', value: '99' }] },
    { sensor: { id: 7002, sensor_type: { name: 'DNMS', manufacturer: 'Test' } }, location: loc(b),
      timestamp: '2026-10-21 10:00:00',
      sensordatavalues: [{ value_type: 'noise_LAeq', value: '58.2' }, { value_type: 'bogus', value: 'NaN' }] },
    { sensor: { id: 7003, sensor_type: { name: 'PMS5003' } }, location: loc(c, { indoor: 1 }),
      timestamp: '2026-10-21 10:00:00', sensordatavalues: [{ value_type: 'P2', value: '40' }] },
    { sensor: { id: 7004 }, location: { latitude: 'nope', longitude: 'nope' }, sensordatavalues: [] },
    { sensor: {}, location: loc(a), sensordatavalues: [] },   // no id
  ]);
}

const FEODO = [
  { ip_address: '203.0.113.66', port: 443, status: 'online', hostname: 'c2.example',
    as_number: 64511, as_name: 'BAD-AS', country: 'XX', first_seen_utc: '2026-10-01 00:00:00',
    last_online: '2026-10-20', malware: 'QakBot' },
  { port: 80 },   // no ip_address: ignored
];

function greyNoise({ url }) {
  const ip = decodeURIComponent(url.pathname.split('/').pop());
  if (ip === '203.0.113.66') {
    return json({ ip, noise: true, riot: false, classification: 'malicious', name: 'unknown',
      last_seen: '2026-10-20', link: 'https://viz.greynoise.io/ip/203.0.113.66', message: 'Success' });
  }
  if (ip === '8.8.8.8') {
    return json({ ip, noise: false, riot: true, classification: 'benign', name: 'Google Public DNS',
      last_seen: '2026-10-20', link: 'javascript:alert(1)', message: 'Success' });
  }
  return json({ ip, noise: false, riot: false, message: 'IP not observed scanning the internet or contained in RIOT data set.' }, { status: 404 });
}

function ioda() {
  return json({ data: [
    { entity: { code: 'US', name: 'United States' }, event_cnt: 3,
      scores: { overall: 1234, 'bgp.median': 1, 'ping-slash24.median': 2, 'merit-nt.median': 3 } },
    { entity: { code: 'ZZ', name: 'Nowhere' }, event_cnt: 1, scores: { overall: 5 } },
    { entity: { code: 'FR', name: 'France' }, event_cnt: 0, scores: {} },
  ] });
}

function eia() {
  return json({ response: { data: [
    { respondent: 'ERCO', 'respondent-name': 'ERCOT', value: 45000, period: '2026-10-21T10', 'value-units': 'megawatthours' },
    { respondent: 'ERCO', 'respondent-name': 'ERCOT', value: 1, period: '2026-10-21T09' },
    { respondent: 'PJM', 'respondent-name': 'PJM Interconnection', value: 90000, period: '2026-10-21T10' },
  ] } });
}

function cloudflare() {
  return json({ result: { annotations: [
    { id: 'cf1', locations: ['US'], asns: [64500], scope: 'Test region', eventType: 'OUTAGE',
      startDate: '2026-10-20T00:00:00Z', endDate: null, description: 'Power outage', linkedUrl: 'https://example.org/x' },
  ] } });
}

function shake() {
  const p = near(0.01, -0.01);
  return text([
    '#Network|Station|Latitude|Longitude|Elevation|SiteName|StartTime|EndTime',
    `AM|R1234|${p.lat}|${p.lon}|500|Test Site |2019-01-01T00:00:00|`,
    'AM|BAD|notanumber|0|0|Broken|2019-01-01T00:00:00|',
    '',
  ].join('\n'));
}

function fiveElevenCameras() {
  const p = near(0.002, 0.0);
  return json([
    { Id: 1, Latitude: p.lat, Longitude: p.lon, Name: 'I-75 @ Test Rd', RoadwayName: 'I-75',
      DirectionOfTravel: 'Northbound', Url: 'https://511ga.org/map/Cctv/1', Status: 'Enabled' },
    { Id: 2, Latitude: 0, Longitude: 0, Name: 'Far away' },
    { Id: 3, Latitude: 'x', Longitude: 'y', Name: 'Broken' },
  ]);
}

function fiveElevenEvents() {
  const p = near(-0.002, 0.001);
  return json([
    { ID: 'e1', Latitude: p.lat, Longitude: p.lon, EventType: 'accidentsAndIncidents',
      RoadwayName: 'I-75', DirectionOfTravel: 'Southbound', Description: 'Crash blocking lanes',
      Severity: 'Major', LanesAffected: '2 Right Lanes', Reported: '2026-10-21T09:00:00', LastUpdated: '2026-10-21T09:30:00' },
  ]);
}

function geoip() {
  return json({
    success: true, ip: '192.0.2.1', latitude: HOME.lat, longitude: HOME.lon,
    city: HOME.city, region: HOME.region, country: HOME.country, country_code: 'TL',
    postal: '12345', timezone: { id: 'America/Chicago' }, connection: { asn: 64500, isp: 'Test ISP' },
  });
}

function adsbdbCallsign({ url }) {
  const cs = decodeURIComponent(url.pathname.split('/').pop());
  if (cs !== 'TST123' && cs !== 'EMG777') return json({ response: 'unknown callsign' }, { status: 404 });
  return json({ response: { flightroute: {
    callsign: cs, callsign_iata: 'TS123',
    airline: { name: 'Test Air', icao: 'TST', iata: 'TS', country: 'Testland', callsign: 'TESTAIR' },
    origin: { icao_code: 'KAAA', iata_code: 'AAA', name: 'Alpha International', municipality: 'Alphaville',
      country_name: 'Testland', latitude: 33.0, longitude: -97.0, elevation: 500 },
    destination: { icao_code: 'KBBB', iata_code: 'BBB', name: 'Bravo Field', municipality: 'Bravotown',
      country_name: 'Testland', latitude: 39.0, longitude: -104.0, elevation: 5000 },
  } } });
}

function adsbdbAircraft({ url }) {
  const hex = url.pathname.split('/').pop();
  if (hex !== 'a1b2c3') return json({ response: 'unknown aircraft' }, { status: 404 });
  return json({ response: { aircraft: {
    registration: 'N12345', type: '737-800', icao_type: 'B738', manufacturer: 'Boeing',
    registered_owner: 'Test Air', registered_owner_country_name: 'Testland',
    registered_owner_operator_flag_code: 'TST', url_photo_thumbnail: 'https://photos.example/a1b2c3.jpg',
  } } });
}

function rainviewer() {
  const t = nowSec();
  return json({
    generated: t, host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [{ time: t - 1200, path: '/v2/radar/1' }, { time: t - 600, path: '/v2/radar/2' }],
      nowcast: [{ time: t + 600, path: '/v2/radar/3' }],
    },
    satellite: { infrared: [] },
  });
}

function windy({ params }) {
  const [n, e, s, w] = String(params.get('bbox') || '').split(',').map(Number);
  const p = place({ south: s, west: w, north: n, east: e }, 0.003, 0.0);
  return json({ webcams: [
    { webcamId: 9001, title: 'Test Ridge', status: 'active', lastUpdatedOn: '2026-10-21T10:00:00Z',
      location: { latitude: p.lat, longitude: p.lon, city: 'Testville', country: 'Testland' },
      images: { current: { preview: 'https://images.windy.example/9001.jpg' } },
      player: { day: 'https://webcams.windy.com/webcams/public/embed/player/9001/day' },
      urls: { detail: 'https://www.windy.com/webcams/9001' } },
    // Player over plain http: must not be accepted for an iframe.
    { webcamId: 9002, title: 'Insecure Player', status: 'active',
      location: { latitude: p.lat + 0.001, longitude: p.lon },
      images: { current: { thumbnail: 'https://images.windy.example/9002.jpg' } },
      player: { day: 'http://insecure.example/player' }, urls: { detail: 'javascript:alert(1)' } },
    { webcamId: 9003, title: 'No location', location: {} },
  ] });
}

function nycDot() {
  const p = near(-0.003, -0.003);
  return json([
    { id: 'nyc-1', name: 'Broadway @ 42nd St', latitude: 40.7578, longitude: -73.9855,
      area: 'Manhattan', isOnline: 'true', imageUrl: 'https://webcams.nyctmc.org/api/cameras/nyc-1/image' },
    { id: 'nyc-home', name: 'Test Ave @ Main St', latitude: String(p.lat), longitude: String(p.lon),
      area: 'Testville', isOnline: true },
    { id: 'nyc-bad', name: 'No coords' },
  ]);
}

function owcdb({ params }) {
  const page = Number(params.get('page') || '1');
  if (page > 1) return json({ data: [], meta: { last_page: 1, total: 2 } });
  const p = near(0.0, 0.003);
  return json({
    data: [
      { slug: 'test-harbour', title: 'Test Harbour', latitude: p.lat, longitude: p.lon,
        city: 'Testville', country: 'Testland', category: 'Harbour',
        thumbnail: 'https://openwebcamdb.com/thumbs/test-harbour.jpg',
        embed_url: 'https://openwebcamdb.com/embed/test-harbour', status: 'active' },
      { id: 'nested', name: 'Nested Location Cam', location: { lat: 51.5, lng: -0.12, city: 'London' },
        categories: [{ name: 'City' }], is_online: false },
      { slug: 'nowhere', title: 'No coordinates' },
    ],
    meta: { last_page: 1, total: 2 },
  });
}

function alertCa() {
  const p = near(0.004, -0.001);
  return json({ features: [
    { attributes: { cameraName: 'Test Peak', siteId: 'TP1', county: 'test county', isActive: 'active',
      isOnline: 'online', cameraURL: 'https://cameras.alertcalifornia.org/?pos=TP1',
      imageURL: 'https://img.alertcalifornia.org/TP1.jpg', viewTime: '2026-10-21T10:00:00Z',
      positionPan: 120.5, positionTilt: -5 }, geometry: { x: p.lon, y: p.lat } },
    { attributes: { cameraName: 'Offline Hill', siteId: 'OH1', isOnline: 'offline' }, geometry: { x: p.lon + 0.001, y: p.lat } },
    { attributes: { cameraName: 'No geometry' } },
  ] });
}

function gdacs() {
  const p = near(0.005, 0.0);
  return json({ features: [
    { geometry: { coordinates: [p.lon, p.lat] }, properties: {
      eventtype: 'EQ', eventid: 1, episodeid: 1, name: 'Earthquake in Testland', alertlevel: 'Red',
      severitydata: { severity: 6.5, severityunit: 'M', severitytext: 'Magnitude 6.5M' },
      country: 'Testland', fromdate: '2026-10-20T00:00:00', todate: '2026-10-21T00:00:00',
      htmldescription: '<b>Strong</b> quake', url: { report: 'https://www.gdacs.org/report.aspx?eventid=1' } } },
    { geometry: { coordinates: [0, 0] }, properties: {
      eventtype: 'FL', eventid: 2, episodeid: 1, name: 'Far away flood', alertlevel: 'Green' } },
    { geometry: null, properties: { eventtype: 'TC', eventid: 3 } },
  ] });
}

function eonet() {
  const p = near(-0.004, 0.004);
  const q = near(0.006, -0.006);
  return json({ features: [
    { geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {
      id: 'EONET_1', title: 'Test Wildfire', categories: [{ title: 'Wildfires' }],
      date: '2026-10-19T00:00:00Z', sources: [{ url: 'https://inciweb.example/1' }],
      magnitudeValue: 1200, magnitudeUnit: 'acres', description: 'A test fire' } },
    { geometry: { type: 'Polygon', coordinates: [[
      [q.lon - 0.01, q.lat - 0.01], [q.lon + 0.01, q.lat - 0.01],
      [q.lon + 0.01, q.lat + 0.01], [q.lon - 0.01, q.lat + 0.01]]] },
    properties: { id: 'EONET_2', title: 'Test Ice Sheet', categories: [{ title: 'Sea and Lake Ice' }] } },
    { geometry: { type: 'LineString', coordinates: [] }, properties: { id: 'EONET_3', title: 'Skipped' } },
  ] });
}

function usgs() {
  const a = near(0.003, -0.005);
  const b = near(-0.005, -0.004);
  const c = near(0.007, 0.007);
  const t = Date.now();
  const q = (id, p, mag, extra = {}) => ({
    id, geometry: { coordinates: [p.lon, p.lat, 10.2] },
    properties: { mag, place: `near ${HOME.city}`, time: t - 3600_000, title: `M ${mag} - near ${HOME.city}`,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, felt: 12, tsunami: 0, ...extra },
  });
  return json({ features: [
    q('us1', a, 4.7), q('us2', b, 2.1, { felt: null }), q('us3', c, 6.2, { tsunami: 1 }),
    { id: 'us4', geometry: { coordinates: [] }, properties: {} },
  ] });
}

function nws() {
  const p = near(0.002, 0.006);
  const ring = [[p.lon - 0.01, p.lat - 0.01], [p.lon + 0.01, p.lat - 0.01], [p.lon + 0.01, p.lat + 0.01],
    [p.lon - 0.01, p.lat + 0.01], [p.lon - 0.01, p.lat - 0.01]];
  const ring2 = ring.map(([x, y]) => [x + 0.004, y - 0.004]);
  return json({ features: [
    { geometry: { type: 'Polygon', coordinates: [ring] }, properties: {
      id: 'urn:oid:1', event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate',
      certainty: 'Observed', areaDesc: 'Test County', onset: '2026-10-21T10:00:00Z',
      ends: '2026-10-21T11:00:00Z', headline: 'Tornado Warning issued for Test County',
      instruction: 'Take shelter now.', '@id': 'https://api.weather.gov/alerts/urn:oid:1' } },
    { geometry: null, properties: { id: 'urn:oid:2', event: 'Wind Advisory', severity: 'Minor' } },
    { geometry: { type: 'MultiPolygon', coordinates: [[ring2]] }, properties: {
      id: 'urn:oid:3', event: 'Flood Watch', severity: 'Moderate', urgency: 'Expected' } },
  ] });
}

function firms({ url }) {
  // .../api/area/csv/<key>/VIIRS_SNPP_NRT/<w,s,e,n>/2
  const area = url.pathname.split('/')[6] || '';
  const [w, s, e, n] = area.split(',').map(Number);
  const p = place({ south: s, west: w, north: n, east: e }, -0.006, 0.0);
  const row = (d, conf, frp) => [p.lat + d, p.lon + d, 330.5, 0.4, 0.4, '2026-10-21', '0930', 'N', 'VIIRS', conf, '2.0NRT', 290.1, frp, 'D'].join(',');
  return text([
    'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
    row(0, 'h', 12.34), row(0.001, 'n', 5.6), row(0.002, 'l', ''),
    'bad,row',
  ].join('\n'));
}

function edis() {
  const p = near(0.001, -0.006);
  return json({ features: [
    { geometry: { coordinates: [p.lon, p.lat] }, properties: {
      id: 'ed1', title: 'Industrial fire', category: 'Fire', severity: 'Orange', country: 'Testland',
      date: '2026-10-21T08:00:00Z', description: 'Large fire at a depot', url: 'javascript:alert(1)' } },
  ] });
}

function nominatim({ params }) {
  const q = String(params.get('q') || '').toLowerCase();
  if (q.includes('nowhere')) return json([]);
  return json([
    { display_name: 'Testville, Test County, Test State, Testland', name: 'Testville',
      lat: String(HOME.lat), lon: String(HOME.lon), type: 'city', category: 'place',
      boundingbox: ['34.9', '35.1', '-100.1', '-99.9'] },
    { display_name: 'Test Lake, Test State, Testland', name: '', lat: '36.0', lon: '-101.0',
      type: 'lake', category: 'natural' },
  ]);
}

function stac() {
  return json({ numberMatched: 3, features: [
    { id: 'S2A_TEST_1', properties: { datetime: '2026-10-18T17:00:00Z', 'eo:cloud_cover': 12.4,
      platform: 'sentinel-2a', 'grid:code': 'MGRS-14SKC' },
      assets: { visual: { href: 'https://sentinel-cogs.example/S2A_TEST_1/TCI.tif' } } },
    { id: 'S2B_TEST_2', properties: { datetime: '2026-10-13T17:00:00Z', 'eo:cloud_cover': 3.1,
      platform: 'sentinel-2b', 's2:granule_id': 'G2' },
      assets: { visual_jp2: { href: 'https://sentinel-cogs.example/S2B_TEST_2/TCI.jp2' } } },
    { id: 'S2A_TEST_3', properties: { datetime: '2026-10-08T17:00:00Z', 'eo:cloud_cover': 1 }, assets: {} },
  ] });
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

const OVERPASS_HOSTS = ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee'];

function registerDefaults(mock) {
  const host = (h, path = '') => (url) => url.hostname === h && url.pathname.startsWith(path);

  mock.on(host('api.shodan.io', '/shodan/host/search'), shodanSearch);
  mock.on(host('api.shodan.io', '/api-info'), () => json({ query_credits: 100, scan_credits: 10, plan: 'test' }));

  mock.on(host('auth.opensky-network.org'), () => json({ access_token: 'opensky-test-token', expires_in: 1800 }));
  mock.on(host('opensky-network.org', '/api/states/all'), openSkyStates);

  mock.on(host('celestrak.org', '/NORAD/elements/gp.php'), () => text(stationsTle()));

  mock.on((url) => OVERPASS_HOSTS.includes(url.hostname), overpass);

  mock.on(host('atlas.ripe.net', '/api/v2/probes'), atlas);
  mock.on(host('opencellid.org', '/cell/getInArea'), openCellId);
  mock.on(host('api.wigle.net', '/api/v2/network/search'), wigle);
  mock.on(host('onionoo.torproject.org', '/details'), onionoo);
  mock.on(host('data.sensor.community', '/airrohr/v1/filter/'), sensorCommunity);

  mock.on(host('feodotracker.abuse.ch'), () => json(FEODO));
  mock.on(host('api.greynoise.io', '/v3/community/'), greyNoise);

  mock.on(host('api.ioda.inetintel.cc.gatech.edu'), ioda);
  mock.on(host('api.eia.gov'), eia);
  mock.on(host('api.cloudflare.com', '/client/v4/radar/'), cloudflare);
  mock.on(host('data.raspberryshake.org'), shake);

  mock.on((url) => url.pathname === '/api/v2/get/cameras', fiveElevenCameras);
  mock.on((url) => url.pathname === '/api/v2/get/event', fiveElevenEvents);

  mock.on(host('ipwho.is'), geoip);
  mock.on(host('api.adsbdb.com', '/v0/callsign/'), adsbdbCallsign);
  mock.on(host('api.adsbdb.com', '/v0/aircraft/'), adsbdbAircraft);

  mock.on(host('api.rainviewer.com'), rainviewer);

  mock.on(host('api.windy.com', '/webcams/'), windy);
  mock.on(host('webcams.nyctmc.org', '/api/cameras'), nycDot);
  mock.on(host('openwebcamdb.com', '/api/v1/webcams'), owcdb);
  mock.on(host('services8.arcgis.com'), alertCa);

  mock.on(host('www.gdacs.org'), gdacs);
  mock.on(host('eonet.gsfc.nasa.gov'), eonet);
  mock.on(host('earthquake.usgs.gov'), usgs);
  mock.on(host('api.weather.gov', '/alerts/active'), nws);
  mock.on(host('firms.modaps.eosdis.nasa.gov', '/api/area/csv/'), firms);
  mock.on(host('edis.example'), edis);

  mock.on(host('nominatim.openstreetmap.org', '/search'), nominatim);
  mock.on(host('earth-search.aws.element84.com', '/v1/search'), stac);
  mock.on(host('oauth2.googleapis.com', '/token'), () => json({ access_token: 'ya29.test', expires_in: 3600 }));
  mock.on(host('earthengine.googleapis.com'), () => json({ name: 'projects/test-project/maps/abc123' }));

  mock.on((url) => /^[a-d]\.basemaps\.cartocdn\.com$/.test(url.hostname), () => png());
  return mock;
}

module.exports = {
  HOME, TEST_KEYS, near, place, registerDefaults, stationsTle, tleEpoch, tleChecksum, FEODO,
  status,
};
