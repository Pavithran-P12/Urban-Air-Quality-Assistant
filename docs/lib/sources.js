/**
 * Where a reading came from and how precise it is. The single source of truth for these labels:
 * shown in the UI, given to the model, and re-applied server-side so a client can never relabel
 * modelled data as measured.
 */

/** @typedef {{provider:'google'|'open-meteo', label:string, kind:'modelled'|'measured', resolution:string}} SourceInfo */

/** @type {Readonly<Record<string, SourceInfo>>} */
export const SOURCES = Object.freeze({
  google: Object.freeze({
    provider: 'google',
    label: 'Google Air Quality API',
    kind: 'modelled',
    resolution: '500 m grid',
  }),
  'open-meteo': Object.freeze({
    provider: 'open-meteo',
    label: 'CAMS global model via Open-Meteo',
    kind: 'modelled',
    resolution: '~45 km grid',
  }),
});
