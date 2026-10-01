// Airline code table: [IATA, ICAO, name].
// Lets people search by the flight number printed on their ticket (e.g. "BA117"),
// even though aircraft broadcast the ICAO callsign (e.g. "BAW117").
// Shared by the browser and the Node server.

export const AIRLINES = [
  ['AA', 'AAL', 'American Airlines'], ['AC', 'ACA', 'Air Canada'], ['AF', 'AFR', 'Air France'],
  ['AI', 'AIC', 'Air India'], ['AM', 'AMX', 'Aeroméxico'], ['AR', 'ARG', 'Aerolíneas Argentinas'],
  ['AS', 'ASA', 'Alaska Airlines'], ['AT', 'RAM', 'Royal Air Maroc'], ['AV', 'AVA', 'Avianca'],
  ['AY', 'FIN', 'Finnair'], ['AZ', 'ITY', 'ITA Airways'], ['A3', 'AEE', 'Aegean Airlines'],
  ['B6', 'JBU', 'JetBlue'], ['BA', 'BAW', 'British Airways'], ['BR', 'EVA', 'EVA Air'],
  ['BT', 'BTI', 'airBaltic'], ['BW', 'BWA', 'Caribbean Airlines'], ['CA', 'CCA', 'Air China'],
  ['CI', 'CAL', 'China Airlines'], ['CM', 'CMP', 'Copa Airlines'], ['CX', 'CPA', 'Cathay Pacific'],
  ['CZ', 'CSN', 'China Southern'], ['DL', 'DAL', 'Delta Air Lines'], ['DY', 'NOZ', 'Norwegian'],
  ['D8', 'NSZ', 'Norwegian Air Sweden'], ['EI', 'EIN', 'Aer Lingus'], ['EK', 'UAE', 'Emirates'],
  ['ET', 'ETH', 'Ethiopian Airlines'], ['EW', 'EWG', 'Eurowings'], ['EY', 'ETD', 'Etihad Airways'],
  ['FI', 'ICE', 'Icelandair'], ['FR', 'RYR', 'Ryanair'], ['FZ', 'FDB', 'flydubai'],
  ['F9', 'FFT', 'Frontier Airlines'], ['GA', 'GIA', 'Garuda Indonesia'], ['GF', 'GFA', 'Gulf Air'],
  ['G3', 'GLO', 'GOL'], ['G9', 'ABY', 'Air Arabia'], ['HA', 'HAL', 'Hawaiian Airlines'],
  ['HU', 'CHH', 'Hainan Airlines'], ['HV', 'TRA', 'Transavia'], ['IB', 'IBE', 'Iberia'],
  ['IX', 'AXB', 'Air India Express'], ['I2', 'IBS', 'Iberia Express'], ['JL', 'JAL', 'Japan Airlines'],
  ['JQ', 'JST', 'Jetstar'], ['J2', 'AHY', 'Azerbaijan Airlines'], ['KC', 'KZR', 'Air Astana'],
  ['KE', 'KAL', 'Korean Air'], ['KL', 'KLM', 'KLM'], ['KM', 'KMM', 'KM Malta Airlines'],
  ['KQ', 'KQA', 'Kenya Airways'], ['KU', 'KAC', 'Kuwait Airways'], ['LA', 'LAN', 'LATAM Airlines'],
  ['LH', 'DLH', 'Lufthansa'], ['LO', 'LOT', 'LOT Polish Airlines'], ['LS', 'EXS', 'Jet2'],
  ['LX', 'SWR', 'SWISS'], ['LY', 'ELY', 'El Al'], ['MH', 'MAS', 'Malaysia Airlines'],
  ['MS', 'MSR', 'EgyptAir'], ['MU', 'CES', 'China Eastern'], ['NH', 'ANA', 'All Nippon Airways'],
  ['NK', 'NKS', 'Spirit Airlines'], ['NZ', 'ANZ', 'Air New Zealand'], ['OK', 'CSA', 'Czech Airlines'],
  ['OS', 'AUA', 'Austrian Airlines'], ['OU', 'CTN', 'Croatia Airlines'], ['OZ', 'AAR', 'Asiana Airlines'],
  ['PC', 'PGT', 'Pegasus Airlines'], ['PK', 'PIA', 'Pakistan International Airlines'],
  ['PA', 'ABQ', 'airblue'], ['ER', 'SEP', 'SereneAir'], ['9P', 'FJL', 'Fly Jinnah'],
  ['PR', 'PAL', 'Philippine Airlines'], ['PS', 'AUI', 'Ukraine International'], ['QF', 'QFA', 'Qantas'],
  ['QR', 'QTR', 'Qatar Airways'], ['RJ', 'RJA', 'Royal Jordanian'], ['SA', 'SAA', 'South African Airways'],
  ['SK', 'SAS', 'SAS'], ['SN', 'BEL', 'Brussels Airlines'], ['SQ', 'SIA', 'Singapore Airlines'],
  ['SU', 'AFL', 'Aeroflot'], ['SV', 'SVA', 'Saudia'], ['S7', 'SBI', 'S7 Airlines'],
  ['TG', 'THA', 'Thai Airways'], ['TK', 'THY', 'Turkish Airlines'], ['TP', 'TAP', 'TAP Air Portugal'],
  ['TR', 'TGW', 'Scoot'], ['UA', 'UAL', 'United Airlines'], ['UK', 'VTI', 'Vistara'],
  ['UL', 'ALK', 'SriLankan Airlines'], ['UX', 'AEA', 'Air Europa'], ['U2', 'EZY', 'easyJet'],
  ['VA', 'VOZ', 'Virgin Australia'], ['VN', 'HVN', 'Vietnam Airlines'], ['VS', 'VIR', 'Virgin Atlantic'],
  ['VY', 'VLG', 'Vueling'], ['W6', 'WZZ', 'Wizz Air'], ['WN', 'SWA', 'Southwest Airlines'],
  ['WS', 'WJA', 'WestJet'], ['WY', 'OMA', 'Oman Air'], ['XQ', 'SXS', 'SunExpress'],
  ['XY', 'KNE', 'flynas'], ['6E', 'IGO', 'IndiGo'], ['SG', 'SEJ', 'SpiceJet'],
  ['QP', 'AKJ', 'Akasa Air'], ['5J', 'CEB', 'Cebu Pacific'], ['AK', 'AXM', 'AirAsia'],
  ['D7', 'XAX', 'AirAsia X'], ['3K', 'JSA', 'Jetstar Asia'], ['MF', 'CXA', 'Xiamen Airlines'],
  ['3U', 'CSC', 'Sichuan Airlines'], ['ZH', 'CSZ', 'Shenzhen Airlines'], ['FM', 'CSH', 'Shanghai Airlines'],
  ['HO', 'DKH', 'Juneyao Air'], ['9C', 'CQH', 'Spring Airlines'], ['7C', 'JJA', 'Jeju Air'],
  ['LJ', 'JNA', 'Jin Air'], ['TW', 'TWB', "T'way Air"], ['BX', 'ABL', 'Air Busan'],
  ['MM', 'APJ', 'Peach Aviation'], ['BC', 'SKY', 'Skymark Airlines'], ['GK', 'JJP', 'Jetstar Japan'],
  ['VJ', 'VJC', 'VietJet Air'], ['QH', 'BAV', 'Bamboo Airways'], ['FD', 'AIQ', 'Thai AirAsia'],
  ['SL', 'TLM', 'Thai Lion Air'], ['JT', 'LNI', 'Lion Air'], ['ID', 'BTK', 'Batik Air'],
  ['OD', 'MXD', 'Batik Air Malaysia'], ['WE', 'THD', 'Thai Smile'], ['PG', 'BKP', 'Bangkok Airways'],
  ['BG', 'BBC', 'Biman Bangladesh'], ['BS', 'UBG', 'US-Bangla Airlines'], ['RA', 'RNA', 'Nepal Airlines'],
  ['MK', 'MAU', 'Air Mauritius'], ['WB', 'RWD', 'RwandAir'], ['KP', 'SKK', 'ASKY Airlines'],
  ['W3', 'ARA', 'Arik Air'], ['TU', 'TAR', 'Tunisair'], ['AH', 'DAH', 'Air Algérie'],
  ['ME', 'MEA', 'Middle East Airlines'], ['IR', 'IRA', 'Iran Air'], ['IA', 'IAW', 'Iraqi Airways'],
  ['J9', 'JZR', 'Jazeera Airways'], ['OV', 'OMS', 'SalamAir'], ['HY', 'UZB', 'Uzbekistan Airways'],
  ['PU', 'PUE', 'Plus Ultra'], ['V7', 'VOE', 'Volotea'], ['EN', 'DLA', 'Air Dolomiti'],
  ['4U', 'GWI', 'Germanwings'], ['DE', 'CFG', 'Condor'], ['X3', 'TUI', 'TUIfly'],
  ['BY', 'TOM', 'TUI Airways'], ['TB', 'JAF', 'TUI fly Belgium'], ['OR', 'TFL', 'TUI fly Netherlands'],
  ['LM', 'LOG', 'Loganair'],
  ['WK', 'EDW', 'Edelweiss Air'], ['RO', 'ROT', 'TAROM'],
  ['FB', 'LZB', 'Bulgaria Air'], ['JU', 'ASL', 'Air Serbia'],
  ['WF', 'WIF', 'Widerøe'], ['FV', 'SDM', 'Rossiya'], ['UT', 'UTA', 'UTair'],
  ['U6', 'SVR', 'Ural Airlines'], ['DP', 'PBD', 'Pobeda'], ['5N', 'AUL', 'Smartavia'],
  ['TS', 'TSC', 'Air Transat'], ['PD', 'POE', 'Porter Airlines'], ['F8', 'FLE', 'Flair Airlines'],
  ['WG', 'SWG', 'Sunwing Airlines'], ['G4', 'AAY', 'Allegiant Air'], ['SY', 'SCX', 'Sun Country'],
  ['MX', 'MXY', 'Breeze Airways'], ['XP', 'VXP', 'Avelo Airlines'], ['QX', 'QXE', 'Horizon Air'],
  ['OO', 'SKW', 'SkyWest Airlines'], ['YX', 'RPA', 'Republic Airways'], ['9E', 'EDV', 'Endeavor Air'],
  ['MQ', 'ENY', 'Envoy Air'], ['OH', 'JIA', 'PSA Airlines'], ['PT', 'PDT', 'Piedmont Airlines'],
  ['YV', 'ASH', 'Mesa Airlines'], ['ZW', 'AWI', 'Air Wisconsin'], ['C5', 'UCA', 'CommuteAir'],
  ['G7', 'GJS', 'GoJet Airlines'], ['AD', 'AZU', 'Azul'], ['JJ', 'TAM', 'LATAM Brasil'],
  ['H2', 'SKU', 'SKY Airline'], ['JA', 'JAT', 'JetSMART'], ['Y4', 'VOI', 'Volaris'],
  ['VB', 'VIV', 'Viva Aerobus'], ['P5', 'RPB', 'Wingo'],
  ['FX', 'FDX', 'FedEx Express'], ['5X', 'UPS', 'UPS Airlines'], ['5Y', 'GTI', 'Atlas Air'],
  ['K4', 'CKS', 'Kalitta Air'], ['CV', 'CLX', 'Cargolux'], ['QY', 'BCS', 'DHL (EAT Leipzig)'],
  ['D0', 'DHK', 'DHL Air UK'], ['ES', 'DHX', 'DHL International'], ['PO', 'PAC', 'Polar Air Cargo'],
  ['3S', 'BOX', 'AeroLogic'], ['RU', 'ABW', 'AirBridgeCargo'], ['M3', 'LTG', 'LATAM Cargo'],
  ['NC', 'NCA', 'Nippon Cargo Airlines'], ['TK', 'TKC', 'Turkish Cargo'], ['QR', 'QAC', 'Qatar Cargo'],
];

const byIata = new Map();
const byIcao = new Map();
for (const [iata, icao, name] of AIRLINES) {
  if (!byIata.has(iata)) byIata.set(iata, { iata, icao, name });
  if (!byIcao.has(icao)) byIcao.set(icao, { iata, icao, name });
}

/** Airline for an ICAO callsign like "BAW117" (null if unknown). */
export function airlineForCallsign(callsign) {
  if (!callsign || callsign.length < 4) return null;
  const prefix = callsign.slice(0, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(prefix) || !/^\d/.test(callsign.slice(3))) return null;
  return byIcao.get(prefix) || null;
}

/** "BAW117" -> "BA117"; returns null when the callsign isn't an airline flight we know. */
export function flightNumberForCallsign(callsign) {
  const airline = airlineForCallsign(callsign);
  if (!airline) return null;
  return airline.iata + callsign.slice(3).toUpperCase();
}

/**
 * All callsigns a user query could refer to.
 * "BA 117" -> ["BA117", "BAW117"], "BAW0117" -> ["BAW0117", "BAW117"], "ek 3" -> ["EK3", "UAE3"].
 */
export function callsignCandidates(query) {
  const q = String(query || '').toUpperCase().replace(/[\s-]/g, '');
  if (!q) return [];
  const out = new Set([q]);
  const iataMatch = q.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (iataMatch && /[A-Z]/.test(iataMatch[1])) {
    const airline = byIata.get(iataMatch[1]);
    if (airline) {
      out.add(airline.icao + iataMatch[2]);
      out.add(airline.icao + iataMatch[2].replace(/^0+(?=\d)/, ''));
    }
  }
  const icaoMatch = q.match(/^([A-Z]{3})(\d{1,4}[A-Z]?)$/);
  if (icaoMatch) out.add(icaoMatch[1] + icaoMatch[2].replace(/^0+(?=\d)/, ''));
  return [...out];
}

/**
 * Callsign prefixes for "show me every flight of this airline" searches:
 * "EK" -> ["EK", "UAE"], "emirates" -> ["UAE"], "PIA" -> ["PIA"].
 */
export function airlinePrefixes(query) {
  const raw = String(query || '').trim();
  const q = raw.toUpperCase().replace(/\s+/g, '');
  if (!q) return [];
  const out = new Set();
  if (/^[A-Z0-9]{2,}$/.test(q)) out.add(q);
  if (q.length === 2 && byIata.has(q)) out.add(byIata.get(q).icao);
  if (raw.length >= 4) {
    const name = raw.toLowerCase();
    for (const [, icao, airlineName] of AIRLINES) {
      if (airlineName.toLowerCase().startsWith(name)) out.add(icao);
    }
  }
  return [...out];
}
