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

const SINCE_YEAR = 2025;


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

    const finalTotals = sumTrackTotals(normalizedTracks);

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
      history: { yearly: [], monthly: [], daily: [] },
      tracks: normalizedTracks,
      updatedAt: new Date().toISOString(),
      meta: {
        apiBaseUrl: getApiBaseUrl(),
        requestedUserUrl: userUrl,
        authMode: collectionAuthMode || authMode,
        manualAdjustmentsApplied: false
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
