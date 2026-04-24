import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import dashboardHandler from "../api/dashboard.js";
import { createJsonResponse, createMockReq, createMockRes } from "./helpers.js";

async function withDashboardEnv(values, callback) {
  const original = new Map();
  for (const key of Object.keys(values)) {
    original.set(key, process.env[key]);
    process.env[key] = values[key];
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("dashboard adds live growth to current year and saves snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "proxy-sc-dashboard-"));
  const stateFile = path.join(tempDir, "dashboard-state.json");

  const responses = [
    createJsonResponse({ id: 42, kind: "user", username: "AREKKUZZERA" }),
    createJsonResponse({
      collection: [
        {
          id: 1,
          title: "Track B",
          playback_count: 7700,
          likes_count: 10,
          comment_count: 2,
          reposts_count: 1,
          download_count: 0,
          permalink_url: "https://soundcloud.com/example/track-b",
          artwork_url: "https://img.example/b.jpg"
        },
        {
          id: 2,
          title: "Track A",
          playback_count: 15800,
          likes_count: 20,
          comment_count: 3,
          reposts_count: 2,
          download_count: 1,
          permalink_url: "https://soundcloud.com/example/track-a",
          artwork_url: "https://img.example/a.jpg"
        }
      ],
      next_href: "https://api-v2.soundcloud.com/users/42/tracks?cursor=next"
    }),
    createJsonResponse({ collection: [] })
  ];

  const originalFetch = global.fetch;
  global.fetch = async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }
    return response;
  };

  try {
    await withDashboardEnv({
      DASHBOARD_STATE_FILE: stateFile,
      DASHBOARD_CURRENT_DATE: "2026-04-24"
    }, async () => {
      const req = createMockReq();
      const res = createMockRes();

      await dashboardHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.artist, "AREKKUZZERA");
      assert.equal(res.body.trackCount, 2);
      assert.equal(res.body.tracks[0].title, "Track A");
      assert.equal(res.body.playback_count, 23500);
      assert.deepEqual(res.body.history.yearly, [
        { label: "2023", plays: 0 },
        { label: "2024", plays: 147 },
        { label: "2025", plays: 15880 },
        { label: "2026", plays: 7473 }
      ]);
      assert.equal(res.body.growth.playback_count.delta, null);
      assert.equal(res.body.growth.playback_count.perDay, null);
      assert.equal(res.getHeader("cache-control"), "public, max-age=0, s-maxage=300, stale-while-revalidate=86400");
      assert.equal(res.body.meta.baselineStatsApplied, true);
      assert.equal(res.body.meta.authMode, "legacy_client_id_fallback");

      const saved = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(saved.date, "2026-04-24");
      assert.equal(saved.playback_count, 23500);
    });
  } finally {
    global.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dashboard returns playback growth from saved previous snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "proxy-sc-dashboard-"));
  const stateFile = path.join(tempDir, "dashboard-state.json");
  await writeFile(stateFile, JSON.stringify({
    date: "2026-04-23",
    playback_count: 23480
  }));

  const responses = [
    createJsonResponse({ id: 42, kind: "user", username: "ploxiii" }),
    createJsonResponse({
      collection: [
        {
          id: 1,
          title: "Track A",
          playback_count: 15800,
          likes_count: 20,
          comment_count: 3,
          reposts_count: 2,
          download_count: 1
        },
        {
          id: 2,
          title: "Track B",
          playback_count: 7700,
          likes_count: 15,
          comment_count: 3,
          reposts_count: 1,
          download_count: 0
        }
      ]
    })
  ];

  const originalFetch = global.fetch;
  global.fetch = async () => responses.shift();

  try {
    await withDashboardEnv({
      DASHBOARD_STATE_FILE: stateFile,
      DASHBOARD_CURRENT_DATE: "2026-04-24"
    }, async () => {
      const req = createMockReq();
      const res = createMockRes();

      await dashboardHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.growth.playback_count.delta, 20);
      assert.equal(res.body.growth.playback_count.perDay, 20);
      assert.equal(res.body.growth.playback_count.previous, 23480);
      assert.equal(res.body.growth.playback_count.snapshotDate, "2026-04-23");
    });
  } finally {
    global.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dashboard works without server-side snapshot storage", async () => {
  const responses = [
    createJsonResponse({ id: 42, kind: "user", username: "Ploxi" }),
    createJsonResponse({
      collection: [
        {
          id: 1,
          title: "Track A",
          playback_count: 12000,
          likes_count: 200,
          comment_count: 10,
          reposts_count: 15,
          download_count: 0
        },
        {
          id: 2,
          title: "Track B",
          playback_count: 11221,
          likes_count: 174,
          comment_count: 19,
          reposts_count: 14,
          download_count: 0
        }
      ]
    })
  ];

  const originalFetch = global.fetch;
  global.fetch = async () => responses.shift();

  try {
    await withDashboardEnv({
      DASHBOARD_STATE_FILE: "",
      DASHBOARD_CURRENT_DATE: "2026-04-24"
    }, async () => {
      const req = createMockReq();
      const res = createMockRes();

      await dashboardHandler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.playback_count, 23423);
      assert.deepEqual(res.body.history.yearly, [
        { label: "2023", plays: 0 },
        { label: "2024", plays: 147 },
        { label: "2025", plays: 15880 },
        { label: "2026", plays: 7396 }
      ]);
      assert.equal(res.body.growth.playback_count.delta, null);
      assert.equal(res.body.meta.snapshotSaved, false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard rejects unsupported methods", async () => {
  const req = createMockReq({ method: "POST" });
  const res = createMockRes();

  await dashboardHandler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.code, "method_not_allowed");
});

test("dashboard validates custom url query parameter", async () => {
  const req = createMockReq({ query: { url: "https://example.com/not-soundcloud" } });
  const res = createMockRes();

  await dashboardHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_soundcloud_url");
});
