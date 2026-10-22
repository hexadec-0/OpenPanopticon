// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
//
// Where Cesium loads its workers and assets from. Kept in its own file rather
// than an inline <script> so the page can run under a Content-Security-Policy
// without 'unsafe-inline'. Must load before Cesium.js; bump with the version
// in index.html (and its integrity hashes).
window.CESIUM_BASE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/cesium/1.145.0/';
