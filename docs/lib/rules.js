/**
 * Deterministic, offline advice engine.
 * Used when Gemini is not configured, fails, or gives ungrounded output, so the app always gives
 * safe, useful guidance. Returns the same shape as the AI response (see ADVICE_SCHEMA in prompt.js).
 * Every recommendation follows BAND_GUIDANCE so it never contradicts the safety level.
 */
import { BAND_GUIDANCE } from './aqi.js';
import { clock } from './time.js';

/** @typedef {import('./types.js').IndoorTip} IndoorTip */

const SENSITIVE = {
  children: 'children',
  elderly: 'elderly family members',
  pregnant: 'anyone pregnant',
  'asthma-or-copd': 'anyone with asthma or COPD',
  'heart-condition': 'anyone with a heart condition',
};

const LEVEL_RANK = { good: 0, moderate: 1, sensitive: 2, unhealthy: 3, 'very-unhealthy': 4, hazardous: 5, unknown: 2 };

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Morning exercise: outside on clean days, indoors otherwise. */
function morningStep(rank) {
  if (rank <= 1) {
    return {
      time: '6-8 AM',
      action: 'Go for your walk, run or yoga outside, away from main roads.',
      why: 'Air is clean enough today; staying 50-100 m from heavy traffic still cuts the exhaust you breathe noticeably.',
    };
  }
  return {
    time: '6-9 AM',
    action:
      rank >= 4
        ? 'Stay in and exercise indoors (yoga, stretching, stairs).'
        : 'Move your workout indoors or keep it short and gentle.',
    why: 'Winter mornings trap smog near the ground (temperature inversion), and hard breathing pulls more fine particles deep into the lungs.',
  };
}

/** Errands at the cleanest hour when air really improves; otherwise keep trips short on bad days. */
function errandsStep(air, rank) {
  const o = air.outlook ?? { improves: false };
  const best = air.cleanestHours.find((h) => h.aqi === o.bestAqi) ?? air.cleanestHours[0];
  if (best && o.improves) {
    return {
      time: clock(best.time),
      action: `Do errands, school runs and air out your home now. AQI drops to about ${best.aqi}.`,
      why: `This is the cleanest hour in the next day, about ${o.drop} points better than now, so you breathe less pollution doing the same things.`,
    };
  }
  if (rank < 2) return null;
  return {
    time: 'All day',
    action: 'Keep outdoor trips short and bundle errands into one trip.',
    why: air.cleanestHours.length
      ? "Air isn't forecast to improve in the next 24 hours, so total time outside is what you can control."
      : "There's no hourly forecast right now, so total time outside is what you can control.",
  };
}

const OPEN_AIR_COMMUTES = ['two-wheeler', 'walk', 'cycle'];

/** Commute advice for how this household travels (none for working from home). */
function commuteStep(commute, rank) {
  if (commute === 'car') {
    return {
      time: 'Commute',
      action: 'Keep windows up with air recirculation on, and car-pool or take the metro when you can.',
      why: 'Recirculation can cut in-cabin fine particles sharply in traffic, and every trip you share removes one car of exhaust from the road.',
    };
  }
  if (OPEN_AIR_COMMUTES.includes(commute)) {
    return {
      time: 'Commute',
      action:
        rank >= 2
          ? 'Wear a well-fitted N95 and take quieter side streets.'
          : 'Take quieter side streets where you can.',
      why: 'Riders and walkers breathe road exhaust directly; a sealed N95 filters about 95% of fine particles and side streets often have far less traffic smoke.',
    };
  }
  if (commute === 'public-transport' && rank >= 2) {
    return {
      time: 'Commute',
      action: 'Wear an N95 while walking to and waiting at the station.',
      why: 'Roadside waiting is where metro and bus riders get most of their exposure.',
    };
  }
  return null;
}

/** Evening: close up as smog rebuilds, and avoid indoor smoke. */
function eveningStep(rank) {
  return {
    time: '6-10 PM',
    action:
      rank >= 2
        ? 'Close windows by sunset and skip incense, mosquito coils and any burning.'
        : 'Close windows at night if smoke from burning drifts in, and skip incense and mosquito coils.',
    why: 'Smog builds again as air cools at night, and indoor smoke adds fine particles right where you sleep.',
  };
}

/** Extra morning step for sensitive household members on poor-air days. */
function sensitiveStep(sensitive, rank) {
  if (!sensitive.length || rank < 2) return null;
  return {
    time: 'Morning',
    action: `Keep ${listJoin(sensitive)} indoors and have any prescribed inhalers or medicines within reach.`,
    why: 'Sensitive groups react at lower pollution levels; being prepared turns a bad-air day into a manageable one.',
  };
}

/** The day plan in time order, at most five steps. The sensitive-group step goes second. */
function buildRoutine(air, profile, rank, sensitive) {
  const steps = [
    morningStep(rank),
    sensitiveStep(sensitive, rank),
    errandsStep(air, rank),
    commuteStep(profile.commute, rank),
    eveningStep(rank),
  ];
  return steps.filter(Boolean).slice(0, 5);
}

/** @type {Readonly<IndoorTip>} */
const SEAL_TIP = Object.freeze({
  tip: 'Seal gaps around windows and doors with tape or a rolled wet towel, and make one "clean room" to sleep in.',
  why: 'At this level outdoor air leaking in is the biggest source of indoor pollution.',
  cost: 'free',
});
/** @type {Readonly<IndoorTip>} */
const PURIFIER_TIP = Object.freeze({
  tip: 'Run your purifier on high in the room you sleep in, door closed. Clean or replace the filter on schedule.',
  why: 'A purifier works best in one closed room; a clogged filter can cut its output a lot.',
  cost: 'free',
});
/** @type {Readonly<IndoorTip>} */
const DIY_PURIFIER_TIP = Object.freeze({
  tip: 'Make a DIY purifier: strap a MERV-13 filter to the back of a box or table fan and run it in the bedroom.',
  why: 'Studies show these cut indoor PM2.5 substantially for a fraction of a purifier price.',
  cost: 'low',
});
/** @type {Readonly<IndoorTip>} */
const VENTILATE_TIP = Object.freeze({
  tip: 'Open windows on opposite sides for 10-15 minutes to cross-ventilate.',
  why: 'When outdoor air is clean, fresh air flushes out cooking fumes, dust and CO₂ that build up indoors.',
  cost: 'free',
});
/** Tips that apply every day, whatever the air. */
const EVERYDAY_TIPS = Object.freeze(
  /** @satisfies {IndoorTip[]} */ ([
    {
      tip: 'Switch on the kitchen chimney or exhaust fan before you start cooking and cover pots.',
      why: 'Cooking, especially frying and tadka, is one of the biggest indoor sources of fine particles.',
      cost: 'free',
    },
    {
      tip: 'Mop with a damp cloth instead of sweeping or dry dusting.',
      why: 'Sweeping throws settled fine dust back into the air you breathe.',
      cost: 'free',
    },
    {
      tip: 'Skip incense, mosquito coils and candles; use a mosquito net or electric repellent instead.',
      why: 'Burning one coil can release as much fine particle pollution as many cigarettes.',
      cost: 'free',
    },
  ]).map((tip) => Object.freeze(tip)),
);

/** Indoor hacks ordered by impact: sealing on very bad days, filtering or airing out, then habits. */
function buildIndoor(profile, rank) {
  const filterOrAir = rank >= 2 ? (profile.hasPurifier ? PURIFIER_TIP : DIY_PURIFIER_TIP) : VENTILATE_TIP;
  return [...(rank >= 4 ? [SEAL_TIP] : []), filterOrAir, ...EVERYDAY_TIPS].slice(0, 5);
}

/**
 * Sustainable swaps, each offered only when it fits this household. Order is priority order.
 * @type {{applies:(p:import('./types.js').Profile)=>boolean, swap:(p:import('./types.js').Profile)=>import('./types.js').Swap}[]}
 */
const SWAP_RULES = [
  {
    applies: (p) => p.cooking === 'biomass' || p.cooking === 'kerosene',
    swap: (p) => ({
      instead: p.cooking === 'biomass' ? 'Cooking on wood or biomass' : 'Cooking on kerosene',
      try: 'LPG (PMUY connection if eligible), piped gas or induction',
      impact: 'Removes most of the smoke your family breathes at home and cuts soot your neighbours breathe too.',
      impactLevel: 'high',
    }),
  },
  {
    applies: (p) => ['wood', 'coal', 'kerosene'].includes(p.heating),
    swap: (p) => ({
      instead: `Heating with ${p.heating}`,
      try: 'An oil-filled electric radiator, warm layers and draught-proofing',
      impact: 'Ends indoor smoke from heating and removes a nightly smoke source from your street.',
      impactLevel: 'high',
    }),
  },
  {
    applies: (p) => p.commute === 'car',
    swap: () => ({
      instead: 'Driving alone',
      try: 'Metro or bus, car-pooling, or an e-bike for trips under 5 km',
      impact:
        'You avoid sitting in traffic exhaust, and each trip you switch removes NO₂ and PM2.5 from roads people walk along.',
      impactLevel: 'medium',
    }),
  },
  {
    applies: (p) => p.commute === 'two-wheeler',
    swap: () => ({
      instead: 'A petrol two-wheeler for short trips',
      try: 'Walking or cycling under 2 km, or an electric scooter',
      impact: 'Cuts tailpipe exhaust on crowded streets; electric scooters have no tailpipe at all.',
      impactLevel: 'medium',
    }),
  },
  {
    applies: (p) => p.heating === 'gas' || p.cooking === 'lpg' || p.cooking === 'piped-gas',
    swap: () => ({
      instead: 'Cooking without ventilation',
      try: 'Always run the chimney or open a window while the gas is on',
      impact: 'Gas flames still release NO₂; venting keeps it from building up indoors.',
      impactLevel: 'low',
    }),
  },
  {
    applies: () => true,
    swap: () => ({
      instead: 'Burning dry leaves or garbage',
      try: 'Compost leaves and hand waste to municipal collection',
      impact: 'Open burning releases dense smoke at street level where children walk and play.',
      impactLevel: 'medium',
    }),
  },
];

function buildSwaps(profile) {
  return SWAP_RULES.filter((rule) => rule.applies(profile))
    .map((rule) => rule.swap(profile))
    .slice(0, 4);
}

/** The single most important action for today's band. */
function topAction(rank) {
  if (rank >= 4) return 'Stay indoors with windows closed and wear an N95 if you must go out.';
  if (rank >= 2) return 'Keep exercise indoors and wear an N95 on busy roads.';
  return 'Enjoy time outside, away from busy roads.';
}

function buildSummary(place, air, rank) {
  const main = air.dominant ? `, mainly ${air.dominant.name.replace(/ \(.*\)$/, '')}` : '';
  const who = air.pm25WhoMultiple ? ` PM2.5 is about ${air.pm25WhoMultiple}× the WHO daily limit.` : '';
  return `Air in ${place.name} is ${air.category.label} right now (AQI ${air.usAqi}${main}).${who} ${topAction(rank)}`;
}

function buildRiskNote(sensitive, rank, guide) {
  if (sensitive.length) {
    return `${listJoin(sensitive).replace(/^./, (c) => c.toUpperCase())} ${rank >= 2 ? 'should limit time outside today.' : 'should be fine, but watch for symptoms.'} See a doctor if anyone has breathlessness, chest tightness or wheezing that does not settle.`;
  }
  if (rank >= 3) {
    return `Even healthy adults may get a sore throat, cough or tired eyes today. Outdoor exercise: ${guide.outdoorExercise}. See a doctor for breathlessness or chest pain.`;
  }
  return 'Low risk for healthy adults today. Children, older people and anyone with asthma should still avoid busy roads.';
}

const QUESTION_FALLBACK =
  "Our AI assistant is busy right now, so we couldn't answer your question. The plan above follows official safety guidance for today's air. Please try again in a minute.";

/**
 * Build advice without AI.
 * @param {import('./types.js').AirReport} report
 * @param {import('./types.js').Profile} profile
 * @returns {import('./types.js').Advice}
 */
export function buildRuleAdvice({ place, air }, profile) {
  const level = air.category.level;
  const rank = LEVEL_RANK[level] ?? 2;
  const guide = BAND_GUIDANCE[level] ?? BAND_GUIDANCE.unknown;
  const sensitive = profile.household.filter((h) => SENSITIVE[h]).map((h) => SENSITIVE[h]);
  return {
    summary: buildSummary(place, air, rank),
    riskNote: buildRiskNote(sensitive, rank, guide),
    routine: buildRoutine(air, profile, rank, sensitive),
    indoor: buildIndoor(profile, rank),
    alternatives: buildSwaps(profile),
    answer: profile.question ? QUESTION_FALLBACK : '',
  };
}
