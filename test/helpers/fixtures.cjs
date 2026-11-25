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
  YOUTUBE_API_KEY: 'test-youtube-SECRET-eeee',
  FLICKR_API_KEY: 'test-flickr-SECRET-1212',
  MAPILLARY_TOKEN: 'MLY|1234|test-mapillary-SECRET-3434',
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
  ACLED_EMAIL: 'analyst@example.org',
  ACLED_PASSWORD: 'test-acled-SECRET-ffff',
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
  // Shodan's geo filter arrives either as a 4-value bounding box
  // (north,west,south,east) or the older centre+radius (lat,lon,km). Place the
  // sample hosts inside whichever the query carried, so a per-cell sweep lands
  // them in that cell rather than defaulting to HOME.
  const bb = /geo:"(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)"/.exec(q);
  const rc = /geo:"(-?[\d.]+),(-?[\d.]+),(\d+(?:\.\d+)?)"/.exec(q);
  let box;
  if (bb) {
    box = { north: num(bb[1]), west: num(bb[2]), south: num(bb[3]), east: num(bb[4]) };
  } else if (rc) {
    const d = num(rc[3]) / 111;
    box = { south: num(rc[1]) - d, north: num(rc[1]) + d, west: num(rc[2]) - d, east: num(rc[2]) + d };
  } else {
    const d = 10 / 111;
    box = { south: HOME.lat - d, north: HOME.lat + d, west: HOME.lon - d, east: HOME.lon + d };
  }
  // Each host sits at a fixed spot just north-east of HOME, both inside the one
  // grid cell north and east of the HOME corner. A box that holds that spot
  // shows the host there. A box that does not: for a view well away from home
  // (the demo's region) it is relocated to the box centre so there is still
  // something to capture; for a home view split across neighbouring cells it is
  // omitted, so a per-cell search never draws the same machine in two places.
  const put = (dLat, dLon) => {
    const pt = near(dLat, dLon);
    if (!box || inBox(box, pt)) return pt;
    const cLat = (box.south + box.north) / 2;
    const cLon = (box.west + box.east) / 2;
    const farFromHome = Math.abs(cLat - HOME.lat) > 1 || Math.abs(cLon - HOME.lon) > 1;
    return farFromHome ? { lat: cLat + dLat / 10, lon: cLon + dLon / 10 } : null;
  };
  const p1 = put(0.002, 0.002);
  const p2 = put(0.002, 0.003);
  const loc = (pt, extra) => (pt ? { latitude: pt.lat, longitude: pt.lon, ...extra } : { ...extra });
  return json({
    total: 3,
    matches: [
      {
        ip_str: '198.51.100.10', port: 443, transport: 'tcp', org: 'Test Hosting', isp: 'Test ISP',
        asn: 'AS64500', product: 'nginx', version: '1.18.0', os: 'Linux',
        hostnames: ['host.example'], tags: ['cloud'], timestamp: '2026-10-20T12:34:56.000000',
        vulns: { 'CVE-2021-44228': {}, 'CVE-2023-0001': {} },
        data: 'HTTP/1.1 200 OK\r\nServer: nginx/1.18.0\r\n',
        location: loc(p1, { city: 'Testville', country_name: 'Testland' }),
      },
      {
        ip_str: '198.51.100.11', port: 502, transport: 'tcp', org: 'Test Water Works',
        product: 'Modbus', data: 'Unit ID: 0',
        location: loc(p2, { city: 'Testville', country_code: 'TL' }),
      },
      // No location: dropped when geolocation is required.
      { ip_str: '198.51.100.12', port: 22, product: 'OpenSSH', location: {} },
    ],
  });
}

// The count endpoint: totals and breakdowns for a whole search area.
function shodanCount() {
  return json({
    total: 125591,
    matches: [],
    facets: {
      port: [{ value: 80, count: 10118 }, { value: 443, count: 9928 }, { value: 22, count: 5099 },
        { value: 502, count: 12 }, { value: 4567, count: 11809 }],
      ip: [{ value: '198.51.100.99', count: 1246 }, { value: '198.51.100.10', count: 3 }],
      org: [{ value: 'Test ISP', count: 40000 }],
    },
  });
}

// One address, every port: 198.51.100.10 answers on three ports, one of
// them SSH; 198.51.100.11 carries hostile text; anything else is unknown.
function shodanHostInfo({ url }) {
  const ip = decodeURIComponent(url.pathname.split('/').pop());
  if (ip === '198.51.100.10') {
    return json({
      ip_str: ip, latitude: 35.002, longitude: -100.002, city: 'Testville', country_name: 'Testland',
      org: 'Test Hosting', asn: 'AS64500', os: 'Linux', hostnames: ['host.example'], tags: ['cloud'],
      ports: [22, 443, 8080], vulns: ['CVE-2021-44228', 'CVE-2023-0001'], last_update: '2026-11-01T00:00:00',
      data: [
        { port: 443, transport: 'tcp', product: 'nginx', version: '1.18.0', data: 'HTTP/1.1 200 OK\r\nServer: nginx\r\n',
          vulns: { 'CVE-2021-44228': {} } },
        { port: 22, transport: 'tcp', product: 'OpenSSH', version: '8.9p1', data: 'SSH-2.0-OpenSSH_8.9p1' },
        { port: 8080, transport: 'tcp', product: 'Apache Tomcat', data: 'HTTP/1.1 404' },
      ],
    });
  }
  if (ip === '198.51.100.11') {
    const XSS = '<img src=x onerror="window.__xss=1">';
    return json({
      ip_str: ip, latitude: 34.998, longitude: -99.997, org: XSS, hostnames: [XSS], ports: [502],
      data: [{ port: 502, transport: 'tcp', product: XSS, version: XSS, data: `</pre>${XSS}` }],
    });
  }
  return json({ error: 'No information available for that IP.' }, { status: 404 });
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
    registered_owner_operator_flag_code: 'TST',
    url_photo: 'https://photos.example/a1b2c3.jpg',
    url_photo_thumbnail: 'https://photos.example/thumbnails/a1b2c3.jpg',
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

// YouTube Data API: two search pages, then the videos.list lookup. Of the
// three ids found, one has no geotag and one is a live stream.
// YouTube live cameras. Two real channels from the README's examples
// (NC State's belltower, Downtown Cary Park), neither with a location set;
// a geotagged harbour camera; and streams the camera filter must refuse.
const YT_CH = { '@ncsu-sat': 'UCncsusatTESTchannel0001', '@caryncgovchannel': 'UCcaryncgovTESTchann0002' };

function youtubeLiveSearch({ params }) {
  const ch = params.get('channelId');
  if (ch === YT_CH['@ncsu-sat']) return json({ items: [{ id: { videoId: 'D9nujG0PUTQ' } }] });
  if (ch === YT_CH['@caryncgovchannel']) return json({ items: [{ id: { videoId: 'YVXZk3-kzcI' } }] });
  if (ch) return json({ items: [] });
  if (params.get('location')) {
    return json({ items: ['ytcamGEO001', 'ytgameGEO02', 'ytendedGEO4'].map((videoId) => ({ id: { videoId } })) });
  }
  // A place-name search ("Testville live cam|…").
  return json({ items: ['YVXZk3-kzcI', 'yttalkshow3', 'ytnamedcam5', 'ytaquarium7', 'ytspring008', 'ytsquare009'].map((videoId) => ({ id: { videoId } })) });
}

function youtubeChannels({ params }) {
  const id = YT_CH[params.get('forHandle')];
  return json(id ? { items: [{ id }] } : { items: [] });
}

function youtubeLiveVideo(id) {
  const p = near(0.004, -0.004);
  const long = new Date(Date.now() - 40 * 86400e3).toISOString();
  const v = (title, channelTitle, channelId, extra = {}) => ({
    id,
    snippet: { title, channelTitle, channelId, categoryId: '22', liveBroadcastContent: 'live', description: '',
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault_live.jpg` } }, ...extra.snippet },
    liveStreamingDetails: { actualStartTime: long, ...extra.live },
    recordingDetails: extra.rec || {},
  });
  return {
    'D9nujG0PUTQ': v('NC State Security Live Stream - NCSU Belltower', 'NC State Security Applications & Technologies', YT_CH['@ncsu-sat']),
    'YVXZk3-kzcI': v('Live View — Downtown Cary Park', 'Cary, NC', YT_CH['@caryncgovchannel']),
    ytcamGEO001: v('Testville Harbour 24/7', 'Harbour Cams', 'UCharbourcamsTESTchan003',
      { rec: { location: { latitude: p.lat, longitude: p.lon } } }),
    ytgameGEO02: v('Minecraft gameplay LIVE', 'Gamer', 'UCgamerTESTchannel000004',
      { snippet: { categoryId: '20' }, rec: { location: { latitude: p.lat, longitude: p.lon } } }),
    ytendedGEO4: v('Harbour cam (ended)', 'Harbour Cams', 'UCharbourcamsTESTchan003',
      { snippet: { liveBroadcastContent: 'none' }, rec: { location: { latitude: p.lat, longitude: p.lon } } }),
    yttalkshow3: v('Testville talk show live', 'Local TV', 'UClocaltvTESTchannel0005'),
    ytnamedcam5: v('Testville Main Street webcam', 'Main Street Assn', 'UCmainstTESTchannel00006'),
    // Found by searching Testville, but somewhere else entirely.
    ytaquarium7: v('Monterey Bay Aquarium Live Cam | Shark Cam', 'Monterey Bay Aquarium', 'UCmbaTESTchannel00000007'),
    ytspring008: v('Springfield live cam', 'Springfield Cams', 'UCspringTESTchannel00008'),
    ytsquare009: v('Testville Square live cam', 'Plaza Cams', 'UCplazaTESTchannel000009'),
  }[id];
}

function youtubeSearch({ params }) {
  if (params.get('eventType') === 'live') return youtubeLiveSearch({ params });
  const second = params.get('pageToken') === 'p2';
  return json({
    items: second
      ? [{ id: { kind: 'youtube#video', videoId: 'cccccccccc3' } }]
      : [{ id: { kind: 'youtube#video', videoId: 'aaaaaaaaaa1' } },
        { id: { kind: 'youtube#video', videoId: 'bbbbbbbbbb2' } },
        // Not a video id: must be ignored rather than looked up.
        { id: { kind: 'youtube#video', videoId: 'bad id"><' } }],
    ...(second ? {} : { nextPageToken: 'p2' }),
  });
}

function youtubeVideos({ params }) {
  const p = near(0.01, 0.01);
  const all = {
    aaaaaaaaaa1: {
      id: 'aaaaaaaaaa1',
      snippet: { title: 'Storm over Testville', channelTitle: 'Test Channel', channelId: 'UCtest',
        publishedAt: new Date(Date.now() - 3600e3).toISOString(), description: 'Shot from the ridge.',
        liveBroadcastContent: 'none',
        thumbnails: { medium: { url: 'https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg' } } },
      recordingDetails: { location: { latitude: p.lat, longitude: p.lon }, locationDescription: 'Testville' },
      contentDetails: { duration: 'PT4M13S' },
      statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' },
    },
    bbbbbbbbbb2: {
      id: 'bbbbbbbbbb2',
      snippet: { title: 'No geotag', channelTitle: 'Other', publishedAt: new Date().toISOString(),
        thumbnails: { default: { url: 'http://insecure.example/x.jpg' } } },
      recordingDetails: {},
    },
    cccccccccc3: {
      id: 'cccccccccc3',
      snippet: { title: 'Live from the harbour', channelTitle: 'Harbour Cam', channelId: 'UCharbour',
        publishedAt: new Date().toISOString(), liveBroadcastContent: 'live',
        thumbnails: { default: { url: 'http://insecure.example/live.jpg' } } },
      recordingDetails: { location: { latitude: p.lat + 0.01, longitude: p.lon } },
      contentDetails: { duration: 'P0D' },
    },
  };
  const ids = String(params.get('id') || '').split(',');
  return json({ items: ids.map((id) => all[id] || youtubeLiveVideo(id)).filter(Boolean) });
}

// Esri World Imagery Wayback. Four releases, one entry pointing elsewhere
// (dropped). Over the test tile, 100 re-published 90's imagery, and 80 is
// the same picture as 70 (identical tile size), so the versions are 90, 70.
const WAYBACK_TILE = (r) => `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${r}/{level}/{row}/{col}`;
const WAYBACK_META = (n) => `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${n}/MapServer`;
function waybackConfig() {
  const item = (r, date) => ({ itemID: `id${r}`, itemTitle: `World Imagery (Wayback ${date})`, itemURL: WAYBACK_TILE(r),
    metadataLayerUrl: WAYBACK_META(r), metadataLayerItemID: `m${r}`, layerIdentifier: `WB_${r}` });
  return json({
    100: item(100, '2026-10-30'), 90: item(90, '2026-06-01'), 80: item(80, '2025-01-15'), 70: item(70, '2024-03-02'),
    66: { ...item(66, '2023-01-01'), itemURL: 'https://evil.example/tile/{level}/{row}/{col}' },
  });
}
function waybackTilemap({ url }) {
  const rel = Number(url.pathname.split('/tilemap/')[1].split('/')[0]);
  const answer = { 100: [90, 5000], 80: [80, 4000], 70: [70, 4000] }[rel];
  return json(answer ? { data: [1], select: [answer[0]], size: [answer[1]], valid: true } : { data: [0], select: [], size: [] });
}
function waybackMetadata({ url }) {
  const rel = /Metadata_(\d+)/.exec(url.pathname)?.[1];
  const when = { 90: Date.UTC(2026, 3, 12), 70: Date.UTC(2023, 10, 5), 80: Date.UTC(2023, 10, 5) }[rel];
  return json({ features: [{ attributes: { SRC_DATE2: when, NICE_DESC: 'Maxar', SRC_DESC: 'WV03', SAMP_RES: 0.3, SRC_ACC: 4.1 } }] });
}

// Space-Track: a cookie on login, then the catalogue as JSON.
function spaceTrackLogin({ body }) {
  const p = new URLSearchParams(String(body || ''));
  if (p.get('password') !== 'test-spacetrack-SECRET-ffff') return json({ Login: 'Failed' });
  return status(200, '""', { 'content-type': 'text/plain', 'set-cookie': 'chocolatechip=st-session; path=/; secure' });
}
function spaceTrackCatalog({ call }) {
  if (!String(call.headers?.cookie || '').includes('chocolatechip=st-session')) return status(401, '{"error":"You must be logged in"}');
  const row = (name, type, l1, l2, extra = {}) => ({ OBJECT_NAME: name, OBJECT_TYPE: type, TLE_LINE0: `0 ${name}`,
    TLE_LINE1: l1, TLE_LINE2: l2, RCS_SIZE: 'LARGE', LAUNCH_DATE: '1998-11-20', MEAN_MOTION: '15.72', ECCENTRICITY: '0.0006', ...extra });
  return json([
    row('ISS (ZARYA)', 'PAYLOAD',
      '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005',
      '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537'),
    row('STARLINK-1007', 'PAYLOAD',
      '1 44713U 19074A   24001.50000000  .00001000  00000-0  80000-4 0  9991',
      '2 44713  53.0540 100.0000 0001400  90.0000 270.0000 15.06400000 12345', { MEAN_MOTION: '15.064' }),
    row('STARLINK DEB', 'DEBRIS',
      '1 99999U 19074ZZ  24001.50000000  .00001000  00000-0  80000-4 0  9991',
      '2 99999  53.0540 100.0000 0001400  90.0000 270.0000 15.06400000 12345'),
  ]);
}

function windy({ params }) {
  const [n, e, s, w] = String(params.get('bbox') || '').split(',').map(Number);
  const p = place({ south: s, west: w, north: n, east: e }, 0.003, 0.0);
  if (Number(params.get('offset') || 0) > 0) return json({ total: 3, webcams: [] });
  return json({ total: 3, webcams: [
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

/** An ADSBx-v2 aggregator answer around /point/{lat}/{lon}/{nm}. */
function adsbPoint({ url }) {
  const m = /\/(-?[\d.]+)\/(-?[\d.]+)\/([\d.]+)$/.exec(url.pathname)
    || /\/lat\/(-?[\d.]+)\/lon\/(-?[\d.]+)\/dist\/([\d.]+)$/.exec(url.pathname);
  const [lat, lon, nm] = m ? m.slice(1).map(Number) : [HOME.lat, HOME.lon, 50];
  const dLat = nm / 60;
  const dLon = nm / 60 / Math.cos(lat * Math.PI / 180);
  const box = { south: lat - dLat / 2, north: lat + dLat / 2, west: lon - dLon / 2, east: lon + dLon / 2 };
  const a = place(box, 0.004, -0.004);
  const mil = place(box, 0.008, 0.002);
  const g = place(box, -0.003, 0.001);
  return json({ now: Date.now(), total: 5, ac: [
    // Also in OpenSky, but heard longer ago here: OpenSky's position stays,
    // the registration and type are added from this side.
    { hex: 'a1b2c3', flight: 'TST123  ', r: 'N123TS', t: 'B738', lat: a.lat, lon: a.lon, alt_baro: 33000,
      alt_geom: 33200, gs: 447, track: 90, baro_rate: 0, squawk: '1200', category: 'A3', nic: 8, nac_p: 10,
      dbFlags: 0, seen_pos: 30, seen: 1 },
    // Only here: a military transport with degraded navigation integrity.
    { hex: 'ae1234', flight: 'RCH417  ', r: '07-7177', t: 'C17', desc: 'BOEING C-17 Globemaster III',
      lat: mil.lat, lon: mil.lon, alt_baro: 31000, alt_geom: 31400, gs: 442, track: 270, geom_rate: -640,
      squawk: '4521', category: 'A5', nic: 0, nac_p: 0, dbFlags: 1, seen_pos: 1.2, seen: 0.5, mlat: [] },
    { hex: 'ffeedd', flight: 'GND1', lat: g.lat, lon: g.lon, alt_baro: 'ground', gs: 0, seen_pos: 4 },
    // Last heard five minutes ago, and one with no position at all.
    { hex: 'c0ffee', flight: 'OLDMIL', lat: a.lat, lon: a.lon, alt_baro: 20000, dbFlags: 1, seen_pos: 300 },
    { hex: 'bad000', flight: 'NOPOS', seen: 2 },
  ] });
}

/** EMSC: one quake USGS also reported (us1), one only EMSC heard. */
function emsc() {
  const a = near(0.003, -0.005);
  const b = near(-0.008, 0.009);
  const t = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('Z', '');
  const f = (unid, p, mag, when, extra = {}) => ({
    type: 'Feature', id: unid, geometry: { type: 'Point', coordinates: [p.lon, p.lat, -10] },
    properties: { unid, lat: p.lat, lon: p.lon, depth: 10, mag, magtype: 'mb', time: when,
      flynn_region: 'TEST REGION', auth: 'EMSC', evtype: 'ke', lastupdate: when, ...extra },
  });
  return json({ type: 'FeatureCollection', features: [
    f('20261121_0000001', a, 4.8, t(3600_000 + 20_000)),
    f('20261121_0000002', b, 5.1, t(1800_000)),
    { type: 'Feature', id: 'bad', geometry: null, properties: {} },
  ] });
}

/** FAA TFR boundaries (GeoServer WFS) and the list they are joined to. */
function tfrShapes() {
  const p = near(0.01, -0.01);
  const ring = [[p.lon - 0.02, p.lat - 0.02], [p.lon + 0.02, p.lat - 0.02], [p.lon + 0.02, p.lat + 0.02],
    [p.lon - 0.02, p.lat + 0.02], [p.lon - 0.02, p.lat - 0.02]];
  const far = ring.map(([x, y]) => [x + 20, y]);
  return json({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'V_TFR_LOC.1', geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { NOTAM_KEY: '6/1234-1-FDC-F', TITLE: 'TESTVILLE, TX, Monday, VIP movement', LEGAL: 'VIP',
        CNS_LOCATION_ID: 'ZKC', STATE: 'TX', LOWER_VAL: 0, UPPER_VAL: 17999, UPPER_UOM: 'FT' } },
    // The same NOTAM's boundary repeated: drawn once.
    { type: 'Feature', id: 'V_TFR_LOC.2', geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { NOTAM_KEY: '6/1234-1-FDC-F', TITLE: 'duplicate' } },
    { type: 'Feature', id: 'V_TFR_LOC.3', geometry: { type: 'Polygon', coordinates: [far] },
      properties: { NOTAM_KEY: '6/9999-1-FDC-F', TITLE: 'Far away' } },
    { type: 'Feature', id: 'V_TFR_LOC.4', geometry: null, properties: {} },
  ] });
}

function tfrList() {
  return json([
    { notam_id: '6/1234', type: 'VIP', facility: 'ZKC', state: 'TX', description: 'Testville, TX — VIP movement' },
    { notam_id: '6/9999', type: 'HAZARDS', facility: 'ZAB', state: 'NM', description: 'Far away' },
  ]);
}

/**
 * MeteoAlarm: Germany has one warning drawn as a polygon around 50.3N 8.3E,
 * one sent with only a region code, and one already expired. Every other
 * country is quiet.
 */
function meteoalarm({ url }) {
  if (!url.pathname.endsWith('feeds-germany')) return json({ warnings: [] });
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString();
  const gone = new Date(Date.now() - 3600_000).toISOString();
  const info = (extra) => ({ language: 'en-GB', event: 'Wind', severity: 'Severe', urgency: 'Immediate',
    certainty: 'Likely', headline: 'Orange wind warning', description: 'Gusts up to 100 km/h.',
    onset: new Date().toISOString(), expires: soon, ...extra });
  return json({ warnings: [
    { uuid: 'w1', alert: { identifier: '2.49.0.0.276.0.DWD.1', sent: new Date().toISOString(), info: [
      info({ language: 'de-DE', headline: 'Amtliche Unwetterwarnung' }),
      info({ area: [{ areaDesc: 'Testkreis', polygon: ['50.2,8.2 50.2,8.4 50.4,8.4 50.4,8.2 50.2,8.2'] }] }),
    ] } },
    { uuid: 'w2', alert: { identifier: '2.49.0.0.276.0.DWD.2', info: [
      info({ event: 'Snow', severity: 'Moderate', headline: 'Snow', area: [{ areaDesc: 'Bergland', geocode: [{ valueName: 'EMMA_ID', value: 'DE999' }] }] }),
    ] } },
    { uuid: 'w3', alert: { identifier: '2.49.0.0.276.0.DWD.3', info: [
      info({ expires: gone, area: [{ areaDesc: 'Old', polygon: '50.2,8.2 50.2,8.4 50.4,8.4 50.2,8.2' }] }),
    ] } },
  ] });
}

/** Copernicus EMS: one live activation at HOME, one closed years ago. */
function cemsList() {
  const p = near(0.002, 0.002);
  return json({ count: 2, next: null, results: [
    { code: 'EMSR900', name: 'Flood in Testville', countries: [{ short_name: 'Testland' }],
      centroid: `POINT (${p.lon} ${p.lat})`, eventTime: '2026-11-20T06:00:00', activationTime: '2026-11-20T09:00:00',
      category: 'Flood', lastUpdate: new Date().toISOString(), closed: false, gdacsId: null, n_aois: 2, n_products: 5 },
    { code: 'EMSR001', name: 'Old flood', centroid: `POINT (${p.lon} ${p.lat})`, category: 'Flood',
      activationTime: '2015-01-01T00:00:00', lastUpdate: '2015-02-01T00:00:00', closed: true },
  ] });
}

function cemsActivation({ params }) {
  if (params.get('code') !== 'EMSR900') return json({ count: 0, results: [] });
  const { lat, lon } = near(0.002, 0.002);
  return json({ count: 1, results: [{ code: 'EMSR900',
    extent: `SRID=4326;MULTIPOLYGON (((${lon - 0.05} ${lat - 0.05}, ${lon + 0.05} ${lat - 0.05}, ${lon + 0.05} ${lat + 0.05}, ${lon - 0.05} ${lat + 0.05}, ${lon - 0.05} ${lat - 0.05})))` }] });
}

/**
 * ODIN county outages inside the asked box: one county near HOME with 4%
 * of customers out, one with no one out, and one record with no geometry.
 */
function odinMap({ params }) {
  if (params.get('scale') !== 'COUNTY') return json({ error: 'bad scale' }, { status: 400 });
  const box = { south: num(params.get('miny')), west: num(params.get('minx')), north: num(params.get('maxy')), east: num(params.get('maxx')) };
  const p = place(box, 0.02, 0.02);
  const ring = [[p.lon - 0.2, p.lat - 0.2], [p.lon + 0.2, p.lat - 0.2], [p.lon + 0.2, p.lat + 0.2], [p.lon - 0.2, p.lat + 0.2], [p.lon - 0.2, p.lat - 0.2]];
  const outage = (id, county, out, served) => ({
    id, countyName: county, stateName: 'Test State', metersOut: out, outageType: 'COUNTY',
    precisionLabel: 'County-level outage summary', sourceType: 'COUNTY',
    feature: { type: 'Polygon', coordinates: [ring], properties: { outage_type: 'COUNTY', metersOut: String(out), county } },
    outages: [{ county: id, metersOut: out, metersServed: served, utilityName: 'TEST ELECTRIC COOP',
      envelope: { minX: p.lon - 0.2, maxX: p.lon + 0.2, minY: p.lat - 0.2, maxY: p.lat + 0.2 } }],
  });
  return json([
    outage('99001', 'Testco', 400, 10000),
    outage('99002', 'Quietco', 0, 5000),
    outage('99004', 'Onehouseco', 1, 8000),
    { id: '99003', countyName: 'Nowhere', metersOut: 5, outages: [] },
  ]);
}

/** ACLED: a token for the test account, then two events near HOME. */
function acledToken({ body }) {
  const f = new URLSearchParams(String(body || ''));
  if (f.get('grant_type') === 'password' && f.get('username') === 'analyst@example.org' && f.get('password') === 'test-acled-SECRET-ffff') {
    return json({ access_token: 'acled-test-token', refresh_token: 'acled-refresh', expires_in: 86400, token_type: 'Bearer' });
  }
  if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'acled-refresh') {
    return json({ access_token: 'acled-test-token-2', refresh_token: 'acled-refresh', expires_in: 86400 });
  }
  return json({ error: 'invalid_grant', error_description: 'Invalid credentials' }, { status: 400 });
}

function acledRead({ params, call }) {
  if (!/^Bearer acled-test-token/.test(call.headers?.authorization || '')) return json({ message: 'Unauthorized' }, { status: 401 });
  const [s, n] = String(params.get('latitude') || '').split('|').map(Number);
  const [w, e] = String(params.get('longitude') || '').split('|').map(Number);
  const p = place({ south: s, north: n, west: w, east: e }, 0.01, -0.01);
  const q = place({ south: s, north: n, west: w, east: e }, -0.01, 0.01);
  return json({ success: true, count: 2, data: [
    { event_id_cnty: 'TST1001', event_date: '2026-11-20', disorder_type: 'Political violence', event_type: 'Battles',
      sub_event_type: 'Armed clash', actor1: 'Test Militia', actor2: 'Test Army', country: 'Testland', admin1: 'Test State',
      location: 'Testville', latitude: String(p.lat), longitude: String(p.lon), geo_precision: '1', source: 'Test Times',
      notes: 'Clash on the outskirts of Testville.', fatalities: '12', timestamp: '1763600000' },
    { event_id_cnty: 'TST1002', event_date: '2026-11-21', disorder_type: 'Demonstrations', event_type: 'Protests',
      sub_event_type: 'Peaceful protest', actor1: 'Protesters (Testland)', country: 'Testland', admin1: 'Test State',
      location: 'Testville', latitude: String(q.lat), longitude: String(q.lon), geo_precision: '2', source: 'Local paper',
      notes: 'Residents rallied at city hall.', fatalities: '0', timestamp: '1763690000' },
    { event_id_cnty: 'TST1003', latitude: '', longitude: '' },
  ] });
}

/** Caltrans: District 7 has two cameras in Los Angeles (one with no image); the rest are empty. */
function caltrans({ url }) {
  if (!url.pathname.includes('/d7/')) return json({ data: [] });
  const cam = (index, name, lat, lon, image, inService = 'true') => ({ cctv: { index, inService,
    location: { district: '7', locationName: name, nearbyPlace: 'Cypress Park', county: 'Los Angeles', route: 'I-110',
      direction: 'South', latitude: String(lat), longitude: String(lon) },
    imageData: { static: { currentImageURL: image }, streamingVideoURL: index === '1' ? 'https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8' : '' } } });
  return json({ data: [
    cam('1', 'I-110 : (196) Avenue 26 Off Ramp', 34.0837, -118.2215, 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196/i110196.jpg'),
    cam('2', 'I-5 : No image', 34.09, -118.23, ''),
    cam('3', 'I-10 : Out', 34.05, -118.25, 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i10/i10.jpg', 'false'),
  ] });
}

function tflJamCams() {
  const prop = (key, value) => ({ key, value, modified: '2026-11-20T11:06:05.68Z' });
  return json([
    { id: 'JamCams_00002.00865', commonName: 'A406 Billet Upass E', lat: 51.6, lon: -0.04, additionalProperties: [
      prop('available', 'true'), prop('imageUrl', 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg'), prop('view', 'West')] },
    { id: 'JamCams_bad', commonName: 'No image', lat: 51.5, lon: -0.1, additionalProperties: [prop('imageUrl', 'javascript:alert(1)')] },
  ]);
}

function digitraffic({ call }) {
  if (call.headers['digitraffic-user'] !== 'OpenPanopticon') return json({ error: 'missing Digitraffic-User' }, { status: 400 });
  return json({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'C01503', geometry: { type: 'Point', coordinates: [23.99616, 60.05374, 0] },
      properties: { id: 'C01503', name: 'kt51_Inkoo', collectionStatus: 'GATHERING', dataUpdatedTime: '2026-11-24T15:25:34Z',
        presets: [{ id: 'C0150301', inCollection: true }, { id: 'C0150302', inCollection: true }, { id: 'C0150309', inCollection: false }] } },
  ] });
}

function driveBc() {
  return json([
    { id: 1033, name: 'Hwy 19A at 17 Street Bridge - N', caption: 'Highway 19A at 17 Street Bridge in Courtenay, looking northbound.',
      location: { type: 'Point', coordinates: [-124.987935, 49.686445] }, highway_display: '19A', orientation: 'N',
      region_name: 'Vancouver Island', is_on: true, should_appear: true, marked_stale: false, marked_delayed: false,
      last_update_modified: '2026-11-24T11:36:38-07:00' },
    { id: 9999, name: 'Hidden', location: { type: 'Point', coordinates: [-124.98, 49.68] }, should_appear: false },
  ]);
}

// The OSIRIS catalogue as the server sees it, with one region whose adapter
// reads from a mock host, so the suite never reaches a real agency.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
function osirisCatalogue() {
  return {
    OSIRIS_COMMIT: 'fixture0000000',
    TEXAS_DISTRICTS: { AUS: 'Austin' },
    TXDOT_BASE: 'https://its.txdot.gov/its/DistrictIts/',
    regionFetchers: {
      'test-region': async () => (await fetch('https://osiris-fixture.example/cameras')).json(),
      'other-region': async () => { throw new Error('not reached'); },
    },
    regionsFor: (lat, lng) => (Math.abs(lat - HOME.lat) < 5 && Math.abs(lng - HOME.lon) < 5 ? ['test-region'] : []),
    fetchScotlandPicture: async (sid) => (sid === '42' ? JPEG : null),
    estoniaFrameUrl: async (id) => (id === 'ee1' ? 'https://pilt.example.ee/cam/ee1-1700000000.jpg' : null),
    singaporeFrameUrl: async () => 'javascript:alert(1)',
  };
}

function osirisCameras() {
  const at = (dLat, dLon) => ({ lat: HOME.lat + dLat, lng: HOME.lon + dLon });
  return json([
    { id: 'tx-1', ...at(0.01, 0.01), name: 'I-35 at Test Rd', city: 'Testville', country: 'US', source: 'TxDOT',
      feed_url: '/api/cctv/texas/snapshot?district=AUS&id=I35%20Test', stream_type: 'jpg' },
    { id: 'still-1', ...at(0.02, 0), name: 'Harbour still', source: 'Example DOT',
      feed_url: 'https://cams.example.gov/still/1.jpg', stream_type: 'jpg', external_url: 'https://cams.example.gov/' },
    { id: 'relay-ok', ...at(0.03, 0), name: 'Relayed but open',
      feed_url: `/api/cctv/proxy?url=${encodeURIComponent('https://open.example.org/c.jpg')}`, stream_type: 'jpg' },
    { id: 'relay-referer', ...at(0.04, 0), name: 'Hotlink protected',
      feed_url: `/api/cctv/proxy?url=${encodeURIComponent('https://stream.inmoves.nl/x.jpg')}`, stream_type: 'jpg' },
    { id: 'mjpeg-1', ...at(0.05, 0), name: 'MJPEG cam', feed_url: 'https://mjpeg.example.net/video.mjpg', stream_type: 'mjpeg' },
    { id: 'hls-1', ...at(0.06, 0), name: 'HLS only', stream_url: 'https://hls.example.net/live.m3u8', stream_type: 'hls' },
    { id: 'iframe-http', ...at(0.07, 0), name: 'Plain http player', stream_url: 'http://player.example.net/', stream_type: 'iframe' },
    { id: 'tfl-dup', ...at(0.08, 0), name: 'Already drawn', feed_url: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/1.jpg' },
    { id: 'js', ...at(0.09, 0), name: 'Bad scheme', feed_url: 'javascript:alert(1)' },
    { id: 'yt-1', ...at(0.035, 0), name: 'Harbour on YouTube', stream_type: 'iframe',
      stream_url: 'https://www.youtube.com/embed/AbCdEfGhIj0?autoplay=1&mute=1&controls=0' },
    { id: 'far', lat: HOME.lat + 3, lng: HOME.lon, name: 'Outside the view', feed_url: 'https://cams.example.gov/far.jpg' },
  ]);
}

// meshmap.net's whole-world file: node number -> node, positions in 1e-7 deg.
function meshtasticNodes() {
  const now = Math.floor(Date.now() / 1000);
  return json({
    9197318: { longName: 'Testville Ridge Router', shortName: 'TRR', hwModel: 'SEEED_SOLAR_NODE', role: 'ROUTER_LATE',
      latitude: Math.round((HOME.lat + 0.01) * 1e7), longitude: Math.round((HOME.lon + 0.01) * 1e7), precision: 15,
      region: 'US', modemPreset: 'LONG_FAST', fwVersion: '2.8.2.7c30267', onlineLocalNodes: 12,
      seenBy: { 'msh/US/2/e/LongFast/!aaaa0001': now - 600, 'msh/US/2/map/': now - 60 } },
    7: { longName: 'Exact handheld', latitude: Math.round((HOME.lat - 0.02) * 1e7), longitude: Math.round(HOME.lon * 1e7),
      precision: 32, role: 'CLIENT', seenBy: { 'msh/US/2/e/LongFast/!aaaa0002': now - 7200 } },
    8: { longName: 'Elsewhere', latitude: 515000000, longitude: -1000000, precision: 13, seenBy: {} },
    9: { longName: 'No position', latitude: 0, longitude: 0 },
  });
}

// map.meshcore.io's whole-world list.
function meshcoreNodes() {
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const key = (c) => c.repeat(64);
  return json([
    { adv_lat: HOME.lat + 0.03, adv_lon: HOME.lon - 0.01, adv_name: 'TV-Repeater-1', public_key: key('a'), type: 2,
      last_advert: ago(0.5), inserted_date: '2026-06-01T00:00:00.000Z', inserted_by: key('f'),
      params: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 }, link: 'meshcore://00' },
    { adv_lat: HOME.lat + 0.04, adv_lon: HOME.lon, adv_name: 'Silent since spring', public_key: key('b'), type: 2,
      last_advert: ago(200) },
    { adv_lat: HOME.lat, adv_lon: HOME.lon, adv_name: 'Bad key', public_key: 'zz', type: 1, last_advert: ago(1) },
    { adv_lat: 0, adv_lon: 0, adv_name: 'Unplaced', public_key: key('c'), type: 1, last_advert: ago(1) },
  ]);
}

function nominatim({ params }) {
  const q = String(params.get('q') || '').toLowerCase();
  if (q.includes('nowhere')) return json([]);
  const one = (name, lat, lon, display) => json([{ name, display_name: display || name, lat: String(lat), lon: String(lon) }]);
  if (q === 'downtown cary park') return one('Downtown Cary Park', 35.7868, -78.7811, 'Downtown Cary Park, Cary, North Carolina');
  if (q.includes('monterey bay aquarium')) return one('Monterey Bay Aquarium', 36.6182, -121.9019);
  if (q.startsWith('springfield')) {
    return json([{ name: 'Springfield', lat: '39.80', lon: '-89.65' }, { name: 'Springfield', lat: '37.21', lon: '-93.29' }]);
  }
  if (q === 'testville square') return one('Testville Square', HOME.lat + 0.004, HOME.lon + 0.003);
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
  mock.on(host('api.shodan.io', '/shodan/host/count'), shodanCount);
  mock.on((url) => url.hostname === 'api.shodan.io' && /^\/shodan\/host\/[0-9a-fA-F.:%]+$/.test(url.pathname), shodanHostInfo);
  mock.on(host('api.shodan.io', '/api-info'), () => json({ query_credits: 100, scan_credits: 10, plan: 'test' }));

  mock.on(host('auth.opensky-network.org'), () => json({ access_token: 'opensky-test-token', expires_in: 1800 }));
  mock.on(host('opensky-network.org', '/api/states/all'), openSkyStates);

  mock.on(host('celestrak.org', '/NORAD/elements/gp.php'), () => text(stationsTle()));
  mock.on(host('www.space-track.org', '/ajaxauth/login'), spaceTrackLogin);
  mock.on(host('www.space-track.org', '/basicspacedata/query/class/gp/'), spaceTrackCatalog);

  mock.on((url) => OVERPASS_HOSTS.includes(url.hostname), overpass);

  // Ship photos: Wikidata knows one ship, IMO 9876543, and Commons has its photo.
  mock.on(host('query.wikidata.org', '/sparql'), ({ params }) => {
    const q = params.get('query') || '';
    const hit = /"9876543"/.test(q);
    return json({ results: { bindings: hit ? [{
      item: { value: 'http://www.wikidata.org/entity/Q1' },
      itemLabel: { value: 'TEST VESSEL' },
      image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Test%20vessel%20at%20sea.jpg' },
    }] : [] } });
  });
  mock.on(host('commons.wikimedia.org', '/w/api.php'), ({ params }) => json({ query: { pages: [{
    title: params.get('titles'),
    imageinfo: [{
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Test_vessel_at_sea.jpg',
      thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Test_vessel_at_sea.jpg/960px-Test_vessel_at_sea.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Test_vessel_at_sea.jpg',
      extmetadata: {
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Tester">A. Photographer</a>' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
      },
    }],
  }] } }));

  // Nearby photos, dated relative to today. Around most points: five recent
  // files within 250 m, plus ones that must be left out: a 2009 photograph
  // uploaded last month, one taken 400 days ago, a PDF, an http thumbnail,
  // and "Far", the newest of all but 3 km away. Latitude 50-60 has two
  // recent files only; above 60, only old ones.
  mock.on((url) => url.hostname === 'commons.wikimedia.org' && url.searchParams.get('generator') === 'geosearch', ({ params }) => {
    const [lat, lon] = String(params.get('ggscoord')).split('|').map(Number);
    if (lat < -80) return json({ batchcomplete: true });
    const ago = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
    const file = (name, dLat, taken, uploaded, extra = {}) => ({
      title: `File:${name}.jpg`,
      coordinates: [{ lat: lat + dLat, lon, primary: true, globe: 'earth' }],
      imageinfo: [{
        timestamp: `${uploaded}T10:00:00Z`, mime: 'image/jpeg',
        url: `https://upload.wikimedia.org/wikipedia/commons/x/xx/${name}.jpg`,
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/x/xx/${name}.jpg/640px-${name}.jpg`,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}.jpg`,
        extmetadata: {
          ...(taken ? { DateTimeOriginal: { value: taken } } : {}),
          Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:T">T. Tester</a>' },
          LicenseShortName: { value: 'CC BY 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0' },
        },
        ...extra,
      }],
    });
    const old = [
      file('Old_square', 0.0001, '2009-06-01 12:00:00', ago(30)),
      file('Stale', 0.0004, ago(400), ago(399)),
    ];
    if (lat > 60) return json({ batchcomplete: true, query: { pages: old } });
    if (lat > 50) {
      return json({ batchcomplete: true, query: { pages: [...old, file('Near', 0.0009, ago(10), ago(9)), file('Far', 0.027, ago(2), ago(1))] } });
    }
    return json({ batchcomplete: true, query: { pages: [
      ...old,
      file('Market', 0.0003, `<time datetime="${ago(20)}">some day</time>`, ago(15)),
      file('Undated_upload', 0.0005, null, ago(40)),
      file('Tower', 0.0007, '2021:07:08', ago(100)),
      file('Street', 0.0009, ago(60), ago(59)),
      file('Bridge', 0.0006, ago(200), ago(199)),
      file('Scan', 0.0002, ago(5), ago(4), { mime: 'application/pdf' }),
      file('Insecure', 0.0002, ago(6), ago(5), { thumburl: 'http://insecure.example/t.jpg' }),
      file('Far', 0.027, ago(2), ago(1)),
    ] } });
  });

  // Flickr: the licence list, and a radius search around the asked point.
  // "Taken long ago" was uploaded recently but taken in 2010; "Near frame"
  // is the closest of all. A wrong key is refused the way Flickr does it:
  // HTTP 200 with stat "fail".
  mock.on((url) => url.hostname === 'api.flickr.com', ({ params }) => {
    if (params.get('api_key') !== 'test-flickr-SECRET-1212') return json({ stat: 'fail', code: 100, message: 'Invalid API Key (Key has invalid format)' });
    if (params.get('method') === 'flickr.photos.licenses.getInfo') {
      return json({ stat: 'ok', licenses: { license: [
        { id: 0, name: 'All Rights Reserved', url: '' },
        { id: 4, name: 'Attribution License', url: 'https://creativecommons.org/licenses/by/2.0/' },
        { id: 11, name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
      ] } });
    }
    const lat = Number(params.get('lat'));
    const lon = Number(params.get('lon'));
    const ago = (n) => new Date(Date.now() - n * 86400e3);
    const photo = (id, title, dLat, taken, uploaded, extra = {}) => ({
      id, owner: '12345@N00', secret: 's', server: '1', title, license: '11',
      datetaken: taken, datetakenunknown: '0', dateupload: String(Math.floor(uploaded.getTime() / 1000)),
      ownername: 'F. Lickr', latitude: String(lat + dLat), longitude: String(lon),
      url_z: `https://live.staticflickr.com/1/${id}_s_z.jpg`, ...extra,
    });
    return json({ stat: 'ok', photos: { page: 1, pages: 1, perpage: 250, total: 4, photo: [
      photo('101', 'Near frame', 0.00002, `${ago(300).toISOString().slice(0, 10)} 09:00:00`, ago(299)),
      photo('102', 'Taken long ago', 0.00003, '2010-01-01 10:00:00', ago(5)),
      photo('103', 'No location', 0.0, `${ago(3).toISOString().slice(0, 10)} 09:00:00`, ago(2), { latitude: '0', longitude: '0' }),
      photo('104', 'Bad owner', 0.00001, `${ago(3).toISOString().slice(0, 10)} 09:00:00`, ago(2), { owner: 'x"><' }),
    ] } });
  });

  // Mapillary: three frames of one drive-past, near the asked point, and a
  // second sequence a little further off.
  mock.on((url) => url.hostname === 'graph.mapillary.com' && url.pathname === '/images', ({ params }) => {
    const [w, s, e, n] = String(params.get('bbox')).split(',').map(Number);
    const lat = (s + n) / 2;
    const lon = (w + e) / 2;
    const ago = (d) => Date.now() - d * 86400e3;
    const frame = (id, seq, dLat, when) => ({
      id, sequence: seq, captured_at: ago(when), is_pano: false,
      computed_geometry: { type: 'Point', coordinates: [lon, lat + dLat] },
      thumb_1024_url: `https://scontent.example.fbcdn.net/m1/${id}.jpg?oh=x&oe=FFFFFFFF`,
      creator: { username: 'streetwalker', id: '9' },
    });
    return json({ data: [
      frame('201', 'SEQ1', 0.00004, 30), frame('202', 'SEQ1', 0.00005, 30), frame('203', 'SEQ1', 0.00006, 30),
      frame('204', 'SEQ2', 0.00007, 10),
    ] });
  });

  mock.on(host('atlas.ripe.net', '/api/v2/probes'), atlas);
  mock.on(host('opencellid.org', '/cell/getInArea'), openCellId);
  mock.on(host('api.wigle.net', '/api/v2/network/search'), wigle);
  mock.on(host('onionoo.torproject.org', '/details'), onionoo);
  mock.on(host('meshmap.net', '/nodes.json'), meshtasticNodes);
  mock.on(host('map.meshcore.io', '/api/v1/nodes'), meshcoreNodes);
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
  mock.on(host('www.googleapis.com', '/youtube/v3/search'), youtubeSearch);
  mock.on(host('www.googleapis.com', '/youtube/v3/videos'), youtubeVideos);
  mock.on(host('www.googleapis.com', '/youtube/v3/channels'), youtubeChannels);
  mock.on(host('cwwp2.dot.ca.gov', '/data/'), caltrans);
  mock.on(host('api.tfl.gov.uk', '/Place/Type/JamCam'), tflJamCams);
  mock.on(host('tie.digitraffic.fi', '/api/weathercam/v1/stations'), digitraffic);
  mock.on(host('www.drivebc.ca', '/api/webcams/'), driveBc);
  mock.on(host('osiris-fixture.example', '/cameras'), osirisCameras);
  mock.on(host('its.txdot.gov', '/its/DistrictIts/GetCctvSnapshotByIcdId'), ({ params }) => (
    params.get('districtCode') === 'AUS' && params.get('icdId') === 'I35 Test'
      ? json({ snippet: JPEG.toString('base64') }) : json({ snippet: '' })));
  mock.on(host('nominatim.openstreetmap.org', '/reverse'), () => json({
    lat: String(HOME.lat), lon: String(HOME.lon), address: { city: 'Testville', state: 'Test State' } }));

  mock.on(host('www.gdacs.org'), gdacs);
  mock.on(host('eonet.gsfc.nasa.gov'), eonet);
  mock.on(host('earthquake.usgs.gov'), usgs);
  mock.on(host('api.weather.gov', '/alerts/active'), nws);
  mock.on(host('firms.modaps.eosdis.nasa.gov', '/api/area/csv/'), firms);
  mock.on(host('edis.example'), edis);

  mock.on(host('nominatim.openstreetmap.org', '/search'), nominatim);

  mock.on((url) => ['api.adsb.lol', 'api.airplanes.live', 'opendata.adsb.fi'].includes(url.hostname), adsbPoint);
  mock.on(host('odin.ornl.gov', '/odi/map'), odinMap);
  mock.on(host('acleddata.com', '/oauth/token'), acledToken);
  mock.on(host('acleddata.com', '/api/acled/read'), acledRead);
  mock.on(host('www.seismicportal.eu', '/fdsnws/event/1/query'), emsc);
  mock.on((url) => url.hostname === 'tfr.faa.gov' && url.pathname.startsWith('/geoserver/'), tfrShapes);
  mock.on(host('tfr.faa.gov', '/tfrapi/exportTfrList'), tfrList);
  mock.on(host('feeds.meteoalarm.org', '/api/v1/warnings/'), meteoalarm);
  mock.on(host('rapidmapping.emergency.copernicus.eu', '/backend/dashboard-api/public-activations-info/'), cemsList);
  mock.on(host('rapidmapping.emergency.copernicus.eu', '/backend/dashboard-api/public-activations/'), cemsActivation);
  mock.on(host('earth-search.aws.element84.com', '/v1/search'), stac);
  mock.on(host('s3-us-west-2.amazonaws.com', '/config.maptiles.arcgis.com/waybackconfig.json'), waybackConfig);
  mock.on(host('wayback.maptiles.arcgis.com', '/arcgis/rest/services/World_Imagery/MapServer/tilemap/'), waybackTilemap);
  mock.on(host('metadata.maptiles.arcgis.com'), waybackMetadata);
  mock.on(host('oauth2.googleapis.com', '/token'), () => json({ access_token: 'ya29.test', expires_in: 3600 }));
  mock.on(host('earthengine.googleapis.com'), () => json({ name: 'projects/test-project/maps/abc123' }));

  mock.on((url) => /^[a-d]\.basemaps\.cartocdn\.com$/.test(url.hostname), () => png());
  return mock;
}

module.exports = {
  HOME, TEST_KEYS, near, place, registerDefaults, osirisCatalogue, JPEG, stationsTle, tleEpoch, tleChecksum, FEODO, waybackTilemap,
  status,
};
