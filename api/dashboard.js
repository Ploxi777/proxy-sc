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
} from "./_lib/soundcloud.js"; // Poprawiona ścieżka z *lib na _lib

// Konfiguracja
const DEFAULT_USER_URL = process.env.SOUNDCLOUD_USER_URL?.trim() || "https://soundcloud.com/ploxiii";
const INCLUDE_MANUAL_ADJUSTMENTS = process.env.DASHBOARD_INCLUDE_MANUAL_ADJUSTMENTS !== "false";

/**
 * UWAGA: SoundCloud API nie zwraca danych historycznych (per day/month).
 * Te dane poniżej musisz edytować RĘCZNIE, aby wykresy na stronie się zmieniły,
 * dopóki nie wdrożysz bazy danych (np. MongoDB/Firebase).
 */
const YEARLY_TOTALS = [
  { label: "2024", total: 4535 },
  { label: "2025", total: 15880 },
  { label: "2026", total: 7328 } // Tutaj wpisz swój aktualny całkowity licznik
];

function cumulativeToGrowth(items) {
  return items.map((item, index) => {
    if (index === 0) return { label: item.label, plays: item.total };
    const previousTotal = items[index - 1].total;
    return {
      label: item.label,
      plays: Math.max(item.total - previousTotal, 0)
    };
  });
}

const MANUAL_ADJUSTMENTS = {
  totals: {
    playback_count: 0, // Dodatkowe odtworzenia (spoza SoundCloud)
    likes: 0,
    comments: 0,
    reposts: 0,
    downloads: 0
  },
  history: {
    yearly: cumulativeToGrowth(YEARLY_TOTALS),
    monthly: [
      { label: "Jan", plays: 1668 },
      { label: "Feb", plays: 1758 },
      { label: "Mar", plays: 1475 },
      { label: "Apr", plays: 2251 }
      // Uzupełnij resztę miesięcy tutaj
    ],
    daily: Array.from({ length: 14 }, (_, index) => ({
      label: String(index + 1),
      plays: 2000 + index * 180
    }))
  }
};

function addTotals(liveTotals, manualTotals) {
  return {
    playback_count: (liveTotals.playback_count || 0) + (manualTotals.playback_count || 0),
    likes: (liveTotals.likes || 0) + (manualTotals.likes || 0),
    comments: (liveTotals.comments || 0) + (manualTotals.comments || 0),
    reposts: (liveTotals.reposts || 0) + (manualTotals.reposts || 0),
    downloads: (liveTotals.downloads || 0) + (manualTotals.downloads || 0)
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

    // 1. Pobierz dane profilu
    const { data: user, authMode } = await resolveResource(userUrl, { expectedKinds: ["user"] });
    const userId = user?.id;

    if (!userId) {
      throw new Error("SoundCloud resolve response did not contain a user id");
    }

    // 2. Pobierz listę utworów (Używamy ` zamiast ')
    const collectionPath = `users/${encodeURIComponent(String(userId))}/tracks`;
    const { items, authMode: collectionAuthMode } = await fetchCollection(collectionPath);

    // 3. Normalizacja i sortowanie utworów
    const normalizedTracks = items
      .map(normalizeTrack)
      .sort((left, right) => (right.playback_count || 0) - (left.playback_count || 0));

    // 4. Sumowanie statystyk LIVE
    const liveTotals = sumTrackTotals(normalizedTracks);
    
    // 5. Połączenie danych Live z Manualnymi (jeśli włączone)
    const manualTotals = INCLUDE_MANUAL_ADJUSTMENTS 
      ? MANUAL_ADJUSTMENTS.totals 
      : { playback_count: 0, likes: 0, comments: 0, reposts: 0, downloads: 0 };

    const finalTotals = addTotals(liveTotals, manualTotals);

    setCacheHeaders(res, {
      browserMaxAge: 0,
      sMaxAge: 300,
      staleWhileRevalidate: 86400
    });

    // 6. Wysłanie odpowiedzi
    return sendJson(res, 200, {
      artist: user?.username || "AREKKUZZERA",
      trackCount: normalizedTracks.length,
      sinceYear: 2016,
      trackTitle: `${user?.username || "Artist"} — All Tracks`,
      playback_count: finalTotals.playback_count,
      likes: finalTotals.likes,
      comments: finalTotals.comments,
      reposts: finalTotals.reposts,
      downloads: finalTotals.downloads,
      history: INCLUDE_MANUAL_ADJUSTMENTS 
        ? MANUAL_ADJUSTMENTS.history 
        : { yearly: [], monthly: [], daily: [] },
      tracks: normalizedTracks,
      updatedAt: new Date().toISOString(),
      meta: {
        apiBaseUrl: getApiBaseUrl(),
        requestedUserUrl: userUrl,
        authMode: collectionAuthMode || authMode,
        manualAdjustmentsApplied: INCLUDE_MANUAL_ADJUSTMENTS
      }
    });

  } catch (error) {
    logError("dashboard", error);
    
    if (error?.code === "soundcloud_captcha_blocked") {
      return sendJson(res, 503, {
        error: "SoundCloud blocked access (Captcha). Try again later.",
        code: "soundcloud_captcha_blocked"
      });
    }

    const { status, payload } = toErrorResponse(error);
    return sendJson(res, status, payload);
  }
}
