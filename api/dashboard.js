import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyCors,
  enforceMethod,
  getQueryValue,
  handlePreflight,
  logError,
  resolveSoundCloudUrl,
  sendJson,
  setCacheHeaders,
  toErrorResponse
} from "./_lib/http.js";

import {
  fetchCollection,
  getApiBaseUrl,
  normalizeTrack,
  resolveResource,
  sumTrackTotals
} from "./_lib/soundcloud.js";

const DEFAULT_USER_URL = "https://soundcloud.com/ploxiii";

const INCLUDE_MANUAL_ADJUSTMENTS =
  process.env.DASHBOARD_INCLUDE_MANUAL_ADJUSTMENTS !== "false";

const SINCE_YEAR = 2025;

const BASELINE_YEARLY_PLAYS = [
  { label: "2023", plays: 0 },
  { label: "2024", plays: 147 },
  { label: "2025", plays: 15880 },
  { label: "2026", plays: 7396 }
];

const EMPTY_HISTORY = { yearly: [], monthly: [], daily: [] };

const BASELINE_STATS = {
  totals: {
    playback_count: 23423,
    likes: 384,
    comments: 25,
    reposts: 36,
    downloads: 0
  },
  history: {
    yearly: BASELINE_YEARLY_PLAYS,
    monthly: [
      { label: "Jan", plays: 1668 },
      { label: "Feb", plays: 1758 },
      { label: "Mar", plays: 1475 },
      { label: "Apr", plays: 2251 },
      { label: "May", plays: 1293 },
      { label: "Jun", plays: 1390 },
      { label: "Jul", plays: 3132 },
      { label: "Aug", plays: 2185 },
      { label: "Sep", plays: 1889 },
      { label: "Oct", plays: 1880 },
      { label: "Nov", plays: 1766 },
      { label: "Dec", plays: 1667 }
    ],
    daily: Array.from({ length: 14 }, (_, index) => ({
      label: String(index + 1),
      plays: 2000 + index * 180
    }))
  }
};

function toPositiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function getDateKey() {
  const configuredDate = process.env.DASHBOARD_CURRENT_DATE;
  const date = configuredDate ? new Date(`${configuredDate}T00:00:00.000Z`) : new Date();
  return Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
}

function getStateFile() {
  return process.env.DASHBOARD_STATE_FILE?.trim() || null;
}

function sumYearlyPlays(items) {
  return items.reduce((total, item) => total + toPositiveInteger(item?.plays), 0);
}

function addLiveGrowthToCurrentYear(baseYearly, livePlaybackCount, dateKey) {
  const currentYear = dateKey.slice(0, 4);
  const extraPlays = Math.max(0, toPositiveInteger(livePlaybackCount) - sumYearlyPlays(baseYearly));
  let currentYearFound = false;

  const yearly = baseYearly.map((item) => {
    if (String(item.label) !== currentYear) return { ...item };

    currentYearFound = true;
    return { ...item, plays: toPositiveInteger(item.plays) + extraPlays };
  });

  if (!currentYearFound) {
    yearly.push({ label: currentYear, plays: extraPlays });
  }

  return yearly;
}

function mergeLiveWithBaseline(liveTotals) {
  return {
    playback_count: Math.max(
      toPositiveInteger(liveTotals.playback_count),
      BASELINE_STATS.totals.playback_count
    ),
    likes: Math.max(toPositiveInteger(liveTotals.likes), BASELINE_STATS.totals.likes),
    comments: Math.max(toPositiveInteger(liveTotals.comments), BASELINE_STATS.totals.comments),
    reposts: Math.max(toPositiveInteger(liveTotals.reposts), BASELINE_STATS.totals.reposts),
    downloads: Math.max(toPositiveInteger(liveTotals.downloads), BASELINE_STATS.totals.downloads)
  };
}

function daysBetween(startDateKey, endDateKey) {
  const start = new Date(`${startDateKey}T00:00:00.000Z`);
  const end = new Date(`${endDateKey}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;

  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

async function readDashboardState() {
  const stateFile = getStateFile();
  if (!stateFile) return null;

  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeDashboardState(state) {
  const stateFile = getStateFile();
  if (!stateFile) return false;

  const directory = stateFile instanceof URL
    ? new URL(".", stateFile)
    : path.dirname(stateFile);

  await mkdir(directory, { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return true;
}

function createPlaybackGrowth(previousState, currentPlaybackCount, dateKey) {
  const previous = toPositiveInteger(previousState?.playback_count, null);
  const snapshotDate = previousState?.date;
  const dayCount = snapshotDate ? daysBetween(snapshotDate, dateKey) : 0;

  if (previous === null || !snapshotDate || dayCount <= 0) {
    return {
      delta: null,
      perDay: null,
      previous: previous ?? null,
      snapshotDate: snapshotDate || null
    };
  }

  const delta = currentPlaybackCount - previous;
  return {
    delta,
    perDay: Math.round(delta / dayCount),
    previous,
    snapshotDate
  };
}

export default async function handler(req, res) {
  applyCors(req, res);

  const preflightResult = handlePreflight(req, res);
  if (preflightResult) return preflightResult;

  if (!enforceMethod(req, res, ["GET"])) return null;

  try {
    const requestedUrl = getQueryValue(req, "url", "user_url", "userUrl");

    const userUrl = resolveSoundCloudUrl(requestedUrl, DEFAULT_USER_URL);

    const { data: user, authMode } = await resolveResource(userUrl, {
      expectedKinds: ["user"]
    });

    const userId = user?.id;

    if (!userId) {
      throw new Error("SoundCloud resolve response did not contain a user id");
    }

    const collectionPath = `users/${encodeURIComponent(String(userId))}/tracks`;

    const { items, authMode: collectionAuthMode } =
      await fetchCollection(collectionPath);

    const normalizedTracks = items
      .map(normalizeTrack)
      .sort(
        (a, b) =>
          (b.playback_count || 0) - (a.playback_count || 0)
      );

    const dateKey = getDateKey();
    const liveTotals = sumTrackTotals(normalizedTracks);
    const finalTotals = INCLUDE_MANUAL_ADJUSTMENTS
      ? mergeLiveWithBaseline(liveTotals)
      : liveTotals;
    const history = INCLUDE_MANUAL_ADJUSTMENTS
      ? {
          ...BASELINE_STATS.history,
          yearly: addLiveGrowthToCurrentYear(
            BASELINE_STATS.history.yearly,
            finalTotals.playback_count,
            dateKey
          )
        }
      : EMPTY_HISTORY;
    const previousState = await readDashboardState();
    const playbackGrowth = createPlaybackGrowth(
      previousState,
      finalTotals.playback_count,
      dateKey
    );

    const snapshotSaved = await writeDashboardState({
      date: dateKey,
      playback_count: finalTotals.playback_count,
      likes: finalTotals.likes,
      comments: finalTotals.comments,
      reposts: finalTotals.reposts,
      downloads: finalTotals.downloads,
      updatedAt: new Date().toISOString()
    });

    setCacheHeaders(res, {
      browserMaxAge: 0,
      sMaxAge: 300,
      staleWhileRevalidate: 86400
    });

    return sendJson(res, 200, {
      artist: user?.username || "ploxiii",
      trackCount: normalizedTracks.length,
      sinceYear: SINCE_YEAR,
      trackTitle: `${user?.username || "ploxiii"} — All Tracks`,
      playback_count: finalTotals.playback_count,
      likes: finalTotals.likes,
      comments: finalTotals.comments,
      reposts: finalTotals.reposts,
      downloads: finalTotals.downloads,
      history,
      growth: {
        playback_count: playbackGrowth
      },
      tracks: normalizedTracks,
      updatedAt: new Date().toISOString(),
      meta: {
        apiBaseUrl: getApiBaseUrl(),
        requestedUserUrl: userUrl,
        authMode: collectionAuthMode || authMode,
        manualAdjustmentsApplied: false,
        baselineStatsApplied: INCLUDE_MANUAL_ADJUSTMENTS,
        snapshotSaved
      }
    });
  } catch (error) {
    logError("dashboard", error);

    if (error?.code === "soundcloud_captcha_blocked") {
      return sendJson(res, 503, {
        error: "SoundCloud temporarily blocked server access with captcha",
        code: "soundcloud_captcha_blocked"
      });
    }

    const { status, payload } = toErrorResponse(error);
    return sendJson(res, status, payload);
  }
}
