export const geocodeResponse = {
  results: [{ name: 'Delhi', admin1: 'Delhi', country: 'India', latitude: 28.65, longitude: 77.23, timezone: 'Asia/Kolkata' }],
};

const hours = Array.from({ length: 48 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 26, 0, 0) + i * 3600_000);
  return d.toISOString().slice(0, 16);
});

export const airResponse = {
  current: {
    time: '2026-11-26T10:00',
    us_aqi: 245,
    pm2_5: 180.4,
    pm10: 260.1,
    nitrogen_dioxide: 60.2,
    ozone: 20.5,
    carbon_monoxide: 1500,
  },
  hourly: {
    time: hours,
    us_aqi: hours.map((_, i) => (i === 14 ? 120 : i === 15 ? 130 : i === 16 ? 140 : 250)),
  },
};

/** Fake fetch that routes by URL. Records calls for assertions. */
export function mockFetch({ geocode = geocodeResponse, air = airResponse, fail = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('network down');
    const body = String(url).includes('geocoding') ? geocode : air;
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}
