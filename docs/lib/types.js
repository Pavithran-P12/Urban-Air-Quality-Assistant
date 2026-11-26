/**
 * Shared JSDoc types for the app's data shapes. No runtime code: editors and reviewers use these
 * to see exactly what flows between the data layer, the rules engine, the prompt and the UI.
 */

/**
 * @typedef {object} Place
 * @property {string} name          Display name, e.g. "Chennai, Tamil Nadu, India"
 * @property {number} latitude
 * @property {number} longitude
 * @property {string|null} [timezone] IANA zone when known
 */

/**
 * @typedef {object} HourAqi
 * @property {string} time  Local time, "YYYY-MM-DDTHH:MM"
 * @property {number} aqi   US AQI
 */

/**
 * @typedef {object} AirReading
 * @property {string} time                         Local observation time
 * @property {number} usAqi
 * @property {boolean} aqiEstimated                True when US AQI was computed from PM2.5
 * @property {string} aqiMethod
 * @property {{max:number, level:string, label:string, color:string}} category
 * @property {Record<'pm2_5'|'pm10'|'nitrogen_dioxide'|'ozone'|'carbon_monoxide', number|null>} pollutants  µg/m³
 * @property {number|null} pm25WhoMultiple
 * @property {{key:string, name:string, aqi:number|null}|null} dominant
 * @property {{code?:string, name:string, aqi:number, category:string}|null} localIndex  e.g. India's NAQI
 * @property {HourAqi[]} [forecast]                Up to 48 hourly values
 * @property {HourAqi[]} cleanestHours             Best 3 of the next 24 hours, in time order
 * @property {{improves:boolean, bestAqi:number|null, drop:number}} outlook
 * @property {import('./sources.js').SourceInfo & {updated?:string}} source
 */

/**
 * @typedef {object} WeatherSummary
 * @property {number|null} temperature      °C
 * @property {number|null} wind             km/h now
 * @property {number|null} windAtBest       km/h at the cleanest hour
 * @property {number|null} rainChanceMax24  %
 */

/**
 * @typedef {object} AirReport
 * @property {Place} place
 * @property {AirReading} air
 * @property {WeatherSummary|null} weather
 * @property {{time:string, wind:number|null, rainChance:number|null}[]} [weatherHours]
 */

/**
 * @typedef {object} Profile
 * @property {string[]} household  Members needing extra care
 * @property {string} commute
 * @property {string} cooking
 * @property {string} heating
 * @property {boolean} hasPurifier
 * @property {string} question     Sanitised free text, may be empty
 */

/**
 * @typedef {object} Advice  Shared by Gemini output and the rules engine (see ADVICE_SCHEMA).
 * @property {string} summary
 * @property {string} riskNote
 * @property {{time:string, action:string, why:string}[]} routine
 * @property {{tip:string, why:string, cost:'free'|'low'|'medium'}[]} indoor
 * @property {{instead:string, try:string, impact:string, impactLevel:'high'|'medium'|'low'}[]} alternatives
 * @property {string} answer
 */

export {};
