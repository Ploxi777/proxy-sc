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

const DEFAULT_USER_URL = process.env.SOUNDCLOUD_USER_URL?.trim() || "https://soundcloud.com/ploxiii";
const INCLUDE_MANUAL_ADJUSTMENTS = process.env.DASHBOARD_INCLUDE_MANUAL_ADJUSTMENTS !== "false";

// --- STATYSTYKI HISTORYCZNE (DO 2025 ROKU) ---
// Te dane są stałe, bo rok 2022-2025 już minął.
const HISTORICAL_DATA = [
  { label: "2022", total: 1200 }, // Wpisz tu realną sumę na koniec 2022
  { label: "2023", total: 3500 }, // Wpisz tu realną sumę na koniec 2023
  { label: "2024", total: 8035 }, // Wpisz tu realną sumę na koniec 2024
  { label: "2025", total: 15880 } // Suma na koniec 2025
];

/**
 * Funkcja generująca historię roczną, w tym dynamiczny rok 2026
 */
function generateYearlyHistory(liveTotal) {
  const currentYear = new Date().getFullYear().toString();
  const history = [...HISTORICAL_DATA];
  
  // Obliczamy ile odtworzeń przybyło w 2026 (Live Total - Suma z 2025)
  const lastYearTotal = HISTORICAL_DATA[HISTORICAL_DATA.length - 1].total;
  const currentYearPlays = Math.max(liveTotal - lastYearTotal, 0);

  // Dodajemy bieżący rok (2026) do wykresu
  history.push({ label: currentYear, total: liveTotal });

  // Przeliczamy na "przyrosty" (żeby wykres pokazywał ile w danym roku, a nie sumę)
  return history.map((item, index) => {
    if (index === 0) return { label: item.label, plays: item.total };
    const prevTotal = history[index - 1].total;
    return {
      label: item.label,
      plays: Math.max(
