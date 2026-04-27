/**
 * RahatNet Demo Seed Script
 *
 * Seeds Firestore with a realistic Kerala 2018 flood simulation dataset:
 *   - 1  DisasterEvent  (Ernakulam, Wayanad, Idukki)
 *   - 200 RawReports    (40 clusters × 5 reports, multilingual)
 *   - 20  Volunteers    (mixed skills, distributed across districts)
 *   - 5   Coordinators  (one per district)
 *   - 3   Resource types (10 boats, 500 food packets, 100 medicine kits)
 *
 * Usage:
 *   pnpm --filter @rahatnet/web seed:demo
 *   # or directly:
 *   npx tsx scripts/seed-demo.ts
 *
 * Idempotent: checks for existing demo data before writing — safe to run
 * multiple times.  All documents carry isDemoData: true for easy cleanup.
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT_BASE64 in apps/web/.env.local
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Bootstrap: load .env.local before any Firebase imports
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env.local');

if (!existsSync(envPath)) {
  console.error('❌  .env.local not found at', envPath);
  console.error('   Copy .env.example to .env.local and fill in the values.');
  process.exit(1);
}

// Manual .env parser — avoids dotenv dependency.
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed.slice(eqIdx + 1).trim();
  if (key && val && !process.env[key]) {
    process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Firebase Admin init
// ---------------------------------------------------------------------------

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;

  const b64 = process.env['FIREBASE_SERVICE_ACCOUNT_BASE64'];
  if (!b64) {
    console.error('❌  FIREBASE_SERVICE_ACCOUNT_BASE64 not set in .env.local');
    process.exit(1);
  }

  const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  initializeApp({ credential: cert(sa) });
}

initAdmin();
const db = getFirestore();

// ---------------------------------------------------------------------------
// ora progress spinner (dynamic import so the script works even if ora is not
// installed — falls back to plain console.log)
// ---------------------------------------------------------------------------

interface Spinner {
  start(text?: string): this;
  succeed(text?: string): this;
  fail(text?: string): this;
  text: string;
}

async function getSpinner(text: string): Promise<Spinner> {
  try {
    const { default: ora } = await import('ora');
    return ora(text).start();
  } catch {
    console.log(`  ${text}`);
    return {
      text,
      start(t?: string) { if (t) console.log(`  ${t}`); return this; },
      succeed(t?: string) { console.log(`  ✔  ${t ?? this.text}`); return this; },
      fail(t?: string) { console.error(`  ✖  ${t ?? this.text}`); return this; },
    };
  }
}

// ---------------------------------------------------------------------------
// Constants — real Kerala GPS coordinates for flood zones
// ---------------------------------------------------------------------------

const DISASTER_ID = 'demo-kerala-flood-2018';

/** 40 representative locations across the Kerala 2018 flood zones */
const FLOOD_LOCATIONS: Array<{ lat: number; lng: number; name: string; district: string }> = [
  { lat: 10.0987, lng: 76.3432, name: 'Aluva Bridge, Ernakulam',            district: 'Ernakulam'  },
  { lat: 10.0562, lng: 76.3892, name: 'Perumbavoor Town, Ernakulam',         district: 'Ernakulam'  },
  { lat: 10.1234, lng: 76.2876, name: 'Thrikkakara, Ernakulam',              district: 'Ernakulam'  },
  { lat: 10.1987, lng: 76.4123, name: 'Muvattupuzha, Ernakulam',             district: 'Ernakulam'  },
  { lat: 10.0345, lng: 76.3234, name: 'Edappally, Ernakulam',                district: 'Ernakulam'  },
  { lat: 10.0765, lng: 76.4456, name: 'Angamaly Town, Ernakulam',            district: 'Ernakulam'  },
  { lat: 10.1543, lng: 76.3012, name: 'North Paravur, Ernakulam',            district: 'Ernakulam'  },
  { lat: 10.0123, lng: 76.3678, name: 'Kalamassery Industrial, Ernakulam',   district: 'Ernakulam'  },
  { lat: 11.6098, lng: 76.0845, name: 'Mananthavady, Wayanad',               district: 'Wayanad'    },
  { lat: 11.4876, lng: 76.1234, name: 'Kalpetta Town, Wayanad',              district: 'Wayanad'    },
  { lat: 11.7234, lng: 75.9876, name: 'Sultan Bathery, Wayanad',             district: 'Wayanad'    },
  { lat: 11.5432, lng: 76.2345, name: 'Vythiri, Wayanad',                    district: 'Wayanad'    },
  { lat: 11.6543, lng: 76.1567, name: 'Ambalavayal, Wayanad',                district: 'Wayanad'    },
  { lat: 11.4321, lng: 76.0432, name: 'Nenmeni, Wayanad',                    district: 'Wayanad'    },
  { lat: 11.7891, lng: 76.0234, name: 'Thirunelli, Wayanad',                 district: 'Wayanad'    },
  { lat: 11.6012, lng: 76.2891, name: 'Meppadi, Wayanad',                    district: 'Wayanad'    },
  { lat: 9.9123,  lng: 77.1234, name: 'Munnar Tea Estate, Idukki',           district: 'Idukki'     },
  { lat: 9.8765,  lng: 76.9876, name: 'Thodupuzha, Idukki',                  district: 'Idukki'     },
  { lat: 10.0234, lng: 77.0543, name: 'Adimali, Idukki',                     district: 'Idukki'     },
  { lat: 9.9876,  lng: 76.8765, name: 'Kattappana, Idukki',                  district: 'Idukki'     },
  { lat: 9.9234,  lng: 77.2345, name: 'Devikulam, Idukki',                   district: 'Idukki'     },
  { lat: 10.0567, lng: 77.1654, name: 'Rajakkad, Idukki',                    district: 'Idukki'     },
  { lat: 9.8432,  lng: 77.0123, name: 'Vandanmedu, Idukki',                  district: 'Idukki'     },
  { lat: 10.1098, lng: 76.9345, name: 'Udumbanchola, Idukki',                district: 'Idukki'     },
  { lat: 10.1432, lng: 76.5234, name: 'Kothamangalam, Ernakulam',            district: 'Ernakulam'  },
  { lat: 10.2123, lng: 76.4789, name: 'Piravom, Ernakulam',                  district: 'Ernakulam'  },
  { lat: 10.0891, lng: 76.5678, name: 'Kalady, Ernakulam',                   district: 'Ernakulam'  },
  { lat: 10.1765, lng: 76.5012, name: 'Kolenchery, Ernakulam',               district: 'Ernakulam'  },
  { lat: 11.5891, lng: 76.0123, name: 'Padinharathara, Wayanad',             district: 'Wayanad'    },
  { lat: 11.6789, lng: 75.9234, name: 'Kaniyambetta, Wayanad',               district: 'Wayanad'    },
  { lat: 9.9543,  lng: 76.8234, name: 'Erattupetta, Kottayam',               district: 'Kottayam'   },
  { lat: 9.7654,  lng: 76.7891, name: 'Pala Town, Kottayam',                 district: 'Kottayam'   },
  { lat: 9.5987,  lng: 76.5234, name: 'Changanacherry, Kottayam',            district: 'Kottayam'   },
  { lat: 9.6543,  lng: 76.6789, name: 'Ettumanoor, Kottayam',               district: 'Kottayam'   },
  { lat: 9.8234,  lng: 77.0678, name: 'Nedumkandam, Idukki',                 district: 'Idukki'     },
  { lat: 9.7891,  lng: 76.9123, name: 'Pampadumpara, Idukki',                district: 'Idukki'     },
  { lat: 10.2345, lng: 76.3456, name: 'Karumaloor, Ernakulam',               district: 'Ernakulam'  },
  { lat: 10.2876, lng: 76.4234, name: 'Vazhakkulam, Ernakulam',              district: 'Ernakulam'  },
  { lat: 11.5234, lng: 76.3012, name: 'Kambalakkad, Wayanad',                district: 'Wayanad'    },
  { lat: 11.6321, lng: 76.0987, name: 'Pulpally, Wayanad',                   district: 'Wayanad'    },
];

/** Unsplash flood photos (public domain) */
const FLOOD_PHOTOS = [
  'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800',
  'https://images.unsplash.com/photo-1504701954957-2010ec3bcec1?w=800',
  'https://images.unsplash.com/photo-1582550945154-cb4b6c7e2e4a?w=800',
  'https://images.unsplash.com/photo-1547036967-23d11aacaee0?w=800',
  'https://images.unsplash.com/photo-1603720997568-ff12cfe4a46c?w=800',
  'https://images.unsplash.com/photo-1541123437800-1bb1317badc2?w=800',
];

// ---------------------------------------------------------------------------
// Report description bank — 5 descriptions per need type × 4 languages
// ---------------------------------------------------------------------------

type LangDescriptions = {
  [needType: string]: Array<{ en: string; ml: string; hi: string; ta: string }>;
};

const DESCRIPTIONS: LangDescriptions = {
  RESCUE: [
    {
      en: 'Three people are stranded on the rooftop of a two-storey building. Water level is rising fast. We need a boat immediately.',
      ml: 'മൂന്ന് ആളുകൾ ഒരു ഇരുനിലക്കെട്ടിടത്തിന്റെ മേൽക്കൂരയിൽ കുടുങ്ങിക്കിടക്കുന്നു. ജലനിരപ്പ് വേഗം ഉയരുന്നു. ഉടൻ ബോട്ട് ആവശ്യമാണ്.',
      hi: 'तीन लोग दो मंजिला इमारत की छत पर फंसे हैं। पानी का स्तर तेजी से बढ़ रहा है। हमें तुरंत नाव चाहिए।',
      ta: 'மூன்று பேர் இரண்டு மாடி கட்டிடத்தின் கூரையில் சிக்கியிருக்கிறார்கள். நீர் மட்டம் வேகமாக உயருகிறது. உடனடியாக படகு தேவை.',
    },
    {
      en: 'An elderly woman and her two grandchildren are trapped inside their home. The ground floor is completely submerged. Please send help fast.',
      ml: 'ഒരു വൃദ്ധ സ്ത്രീയും അവരുടെ രണ്ട് കൊച്ചുമക്കളും വീടിനകത്ത് കുടുങ്ങിയിരിക്കുന്നു. ഒന്നാം നില പൂർണ്ണമായും വെള്ളത്തിൽ മുങ്ങിയിരിക്കുന്നു.',
      hi: 'एक बुजुर्ग महिला और उनके दो पोते-पोतियां घर के अंदर फंसे हैं। भूतल पूरी तरह से जलमग्न है। कृपया जल्दी मदद भेजें।',
      ta: 'ஒரு வயதான பெண்மணியும் அவரது இரு பேரக்குழந்தைகளும் வீட்டில் சிக்கியுள்ளனர். தரை மாடி முழுவதும் நீரில் மூழ்கியுள்ளது.',
    },
    {
      en: 'A family of 6 including a pregnant woman is stuck on the second floor. Their building looks structurally unsafe. Urgent rescue needed.',
      ml: 'ഗർഭിണിയായ ഒരു സ്ത്രീ ഉൾപ്പെടെ 6 അംഗ കുടുംബം രണ്ടാം നിലയിൽ കുടുങ്ങിയിരിക്കുന്നു. കെട്ടിടം ഘടനാപരമായി സുരക്ഷിതമല്ല.',
      hi: 'एक गर्भवती महिला समेत 6 सदस्यीय परिवार दूसरी मंजिल पर फंसा है। इमारत संरचनात्मक रूप से असुरक्षित लगती है।',
      ta: 'கர்ப்பிணி பெண்ணையும் சேர்த்து 6 பேர் கொண்ட குடும்பம் இரண்டாம் மாடியில் சிக்கியுள்ளனர். கட்டிடம் கட்டமைப்பு ரீதியாக பாதுகாப்பற்றது.',
    },
    {
      en: 'Motor boat needed urgently. At least 15 people marooned on a small hillock surrounded by floodwater. Some have been here since yesterday.',
      ml: 'മോട്ടോർ ബോട്ട് അടിയന്തരമായി ആവശ്യം. വെള്ളപ്പൊക്ക ജലത്തിൽ ചുറ്റപ്പെട്ട ഒരു കൊച്ചു കുന്നിൽ ഏകദേശം 15 പേർ കുടുങ്ങിയിരിക്കുന്നു.',
      hi: 'मोटर बोट की तत्काल जरूरत है। बाढ़ के पानी से घिरी एक छोटी पहाड़ी पर कम से कम 15 लोग फंसे हैं।',
      ta: 'மோட்டார் படகு அவசரமாக தேவை. வெள்ளத்தால் சூழப்பட்ட ஒரு சிறு குன்றில் குறைந்தது 15 பேர் சிக்கியுள்ளனர்.',
    },
    {
      en: 'Man with heart condition stranded in house. Water at chest level inside the house now. He cannot walk. Need immediate evacuation.',
      ml: 'ഹൃദ്രോഗമുള്ള ഒരു വ്യക്തി വീടിൽ കുടുങ്ങിയിരിക്കുന്നു. വീടിനകത്ത് ഇപ്പോൾ നെഞ്ചുവരെ വെള്ളം. അദ്ദേഹത്തിന് നടക്കാൻ കഴിയില്ല.',
      hi: 'हृदय रोगी एक व्यक्ति घर में फंसा है। अब घर के अंदर छाती तक पानी है। वह चल नहीं सकता।',
      ta: 'இதய நோயாளி ஒருவர் வீட்டில் சிக்கியுள்ளார். வீட்டினுள் இப்போது மார்பு அளவு நீர் உள்ளது. அவரால் நடக்க முடியாது.',
    },
  ],
  FOOD: [
    {
      en: 'We have been without food for 2 days. Stranded family of 8 including 3 children. Running out of drinking water too.',
      ml: '2 ദിവസമായി ഞങ്ങൾക്ക് ഭക്ഷണം ലഭിച്ചിട്ടില്ല. 3 കുട്ടികൾ ഉൾപ്പെടെ 8 അംഗ കുടുംബം. കുടിവെള്ളവും ഇല്ലാതാകുന്നു.',
      hi: '2 दिनों से हमारे पास खाना नहीं है। 3 बच्चों समेत 8 लोगों का परिवार। पीने का पानी भी खत्म हो रहा है।',
      ta: '2 நாட்களாக எங்களிடம் உணவு இல்லை. 3 குழந்தைகள் உட்பட 8 பேர் கொண்ட குடும்பம். குடிநீரும் தீர்ந்து போகிறது.',
    },
    {
      en: 'Relief camp at local school running very low on food supplies. About 150 displaced people here. Need urgent food aid.',
      ml: 'പ്രാദേശിക സ്കൂളിലെ ദുരിതാശ്വാസ ക്യാമ്പ് ഭക്ഷ്യ ഉൽപ്പന്നങ്ങൾ കുറഞ്ഞ് വരുന്നു. ഇവിടെ ഏകദേശം 150 ആളുകൾ. അടിയന്തര ഭക്ഷ്യ സഹായം ആവശ്യം.',
      hi: 'स्थानीय स्कूल में राहत शिविर में खाद्य आपूर्ति बहुत कम हो रही है। यहाँ लगभग 150 विस्थापित लोग हैं।',
      ta: 'உள்ளூர் பள்ளியில் நிவாரண முகாம் உணவு பொருட்கள் குறைந்து வருகின்றன. சுமார் 150 இடம்பெயர்ந்த மக்கள் இங்கு உள்ளனர்.',
    },
    {
      en: 'Baby food urgently needed. There are 4 infants under 1 year old in our group. No baby formula available anywhere near us.',
      ml: 'ശിശু ഭക്ഷണം അടിയന്തരമായി ആവശ്യം. ഞങ്ങളുടെ ഗ്രൂപ്പിൽ 1 വയസ്സിൽ താഴെ 4 ശിശുക്കൾ ഉണ്ട്. ഞങ്ങൾക്കടുത്ത് ശിശു ഭക്ഷണം ലഭ്യമല്ല.',
      hi: 'शिशु आहार की तत्काल जरूरत है। हमारे समूह में 1 साल से कम उम्र के 4 शिशु हैं। हमारे पास कोई बेबी फॉर्मूला उपलब्ध नहीं है।',
      ta: 'குழந்தை உணவு அவசரமாக தேவை. எங்கள் குழுவில் 1 வயதிற்கு உட்பட்ட 4 குழந்தைகள் உள்ளனர். எங்களுக்கு அருகில் பால் பொடி கிடைக்கவில்லை.',
    },
    {
      en: 'Group of 25 flood victims sheltering in temple. No meals since morning. Elderly and diabetic patients among them need food immediately.',
      ml: '25 ​​പ്രളയ ബാധിതർ ക്ഷേത്രത്തിൽ അഭയം തേടിയിരിക്കുന്നു. രാവിലെ മുതൽ ഭക്ഷണം ലഭിച്ചിട്ടില്ല. അവരിൽ വൃദ്ധരും പ്രമേഹ രോഗികളും ഉൾക്കൊള്ളുന്നു.',
      hi: '25 बाढ़ पीड़ित मंदिर में शरण लिए हुए हैं। सुबह से कोई भोजन नहीं। उनमें बुजुर्ग और मधुमेह रोगी हैं।',
      ta: '25 வெள்ள பாதிக்கப்பட்டோர் கோயிலில் தஞ்சம் புகுந்துள்ளனர். காலை முதல் உணவு இல்லை. அவர்களில் முதியோர்களும் நீரிழிவு நோயாளிகளும் உள்ளனர்.',
    },
    {
      en: 'Isolated village. Road fully cut off. 60+ people need food parcels. Last supply arrived 3 days ago via helicopter.',
      ml: 'ഒറ്റപ്പെട്ട ഗ്രാമം. റോഡ് പൂർണ്ണമായും വിച്ഛേദിക്കപ്പെട്ടിരിക്കുന്നു. 60-ലധികം ആളുകൾക്ക് ഭക്ഷ്യ പൊതികൾ ആവശ്യം. 3 ദിവസം മുൻപ് ഹെലികോപ്റ്ററിൽ വന്ന അവസാന സൂഷ്മ.',
      hi: 'अलग-थलग गाँव। सड़क पूरी तरह कट गई है। 60+ लोगों को खाद्य पैकेट चाहिए। 3 दिन पहले हेलिकॉप्टर से आखिरी आपूर्ति आई थी।',
      ta: 'தனிமைப்படுத்தப்பட்ட கிராமம். சாலை முழுவதும் துண்டிக்கப்பட்டுள்ளது. 60க்கும் மேற்பட்டோருக்கு உணவு பொட்டலங்கள் தேவை.',
    },
  ],
  MEDICINE: [
    {
      en: 'Diabetic patient has run out of insulin. She has not had her medication for 48 hours. Her condition is deteriorating.',
      ml: 'പ്രമേഹ രോഗിക്ക് ഇൻസുലിൻ തീർന്നു. 48 മണിക്കൂർ ആയി മരുന്ന് കഴിച്ചിട്ടില്ല. അവരുടെ അവസ്ഥ മോശമാകുന്നു.',
      hi: 'मधुमेह रोगी का इंसुलिन खत्म हो गया है। उन्होंने 48 घंटे से दवा नहीं ली है। उनकी हालत बिगड़ रही है।',
      ta: 'நீரிழிவு நோயாளிக்கு இன்சுலின் தீர்ந்துவிட்டது. 48 மணி நேரமாக மருந்து எடுத்துக்கொள்ளவில்லை. அவரது நிலை மோசமாகி வருகிறது.',
    },
    {
      en: 'Child aged 4 running high fever for 2 days. Need paracetamol and ORS sachets urgently. Cannot reach hospital.',
      ml: '4 വയസ്സുള്ള കുട്ടിക്ക് 2 ദിവസമായി ഉയർന്ന പനി. പാരസെറ്റമോൾ, ORS ഉടൻ ആവശ്യം. ആശുപത്രിയിൽ എത്താൻ കഴിയുന്നില്ല.',
      hi: '4 साल के बच्चे को 2 दिनों से तेज बुखार है। पैरासिटामोल और ORS की तत्काल जरूरत है। अस्पताल नहीं पहुँच सकते।',
      ta: '4 வயது குழந்தைக்கு 2 நாட்களாக அதிக காய்ச்சல். பாராசிட்டமால் மற்றும் ORS உடனடியாக தேவை. மருத்துவமனைக்கு செல்ல முடியவில்லை.',
    },
    {
      en: 'Asthma patient without inhaler for 3 days. Breathing difficulty getting worse due to damp conditions. Please send inhaler.',
      ml: '3 ദിവസമായി ഇൻഹേലർ ഇല്ലാതെ ആസ്ത്മ രോഗി. ഈർപ്പമുള്ള അന്തരീക്ഷം കാരണം ശ്വാസ ബുദ്ധിമുട്ട് വഷളാകുന്നു.',
      hi: 'अस्थमा रोगी 3 दिनों से बिना इनहेलर के हैं। नमी के कारण सांस लेने में तकलीफ बढ़ रही है। कृपया इनहेलर भेजें।',
      ta: 'ஆஸ்துமா நோயாளி 3 நாட்களாக இன்ஹேலர் இல்லாமல் உள்ளார். ஈரமான சூழ்நிலையால் மூச்சுத்திணறல் அதிகமாகிறது.',
    },
    {
      en: 'Wound getting infected. No antiseptic or bandages available. Person fell on debris during evacuation attempt. Need first aid kit.',
      ml: 'മുറிവ് അണുബാധ ഉണ്ടാകുന്നു. ആന്റിസെപ്റ്റിക് അല്ലെങ്കിൽ ബാൻഡേജ് ലഭ്യമല്ല. ഒഴിപ്പിക്കൽ ശ്രമത്തിൽ അവശിഷ്ടങ്ങളിൽ വീണ വ്യക്തി.',
      hi: 'घाव में संक्रमण हो रहा है। कोई एंटीसेप्टिक या पट्टी उपलब्ध नहीं है। निकासी प्रयास के दौरान मलबे पर गिरा व्यक्ति।',
      ta: 'காயம் தொற்று ஏற்படுகிறது. ஆண்டிசெப்டிக் அல்லது கட்டுகள் கிடைக்கவில்லை. வெளியேற்றும் முயற்சியில் இடிபாடுகளில் விழுந்தவர்.',
    },
    {
      en: 'Blood pressure tablets finished. Hypertensive patient aged 68. Last dose was this morning. Family very worried.',
      ml: 'ബ്ലഡ് പ്രഷർ ഗുളികകൾ തീർന്നു. 68 വയസ്സ് ഉള്ള രക്തസമ്മർദ്ദ രോഗി. ഇന്ന് രാവിലെ ആണ് അവസാനമായി കഴിച്ചത്.',
      hi: 'ब्लड प्रेशर की गोलियाँ खत्म हो गई हैं। 68 साल के उच्च रक्तचाप के रोगी। आखिरी खुराक आज सुबह थी।',
      ta: 'ரத்த அழுத்த மாத்திரைகள் தீர்ந்துவிட்டன. 68 வயது உயர் ரத்த அழுத்த நோயாளி. கடைசி டோஸ் இன்று காலை.',
    },
  ],
  SHELTER: [
    {
      en: 'House roof collapsed. Family of 5 has no shelter. Standing in rain outside with small children. Need tarpaulin or tent immediately.',
      ml: 'വീടിന്റെ മേൽക്കൂര തകർന്നു. 5 അംഗ കുടുംബത്തിന് ഇനി അഭയം ഇല്ല. ചെറിയ കുട്ടികളുമായി മഴയത്ത് പുറത്ത് നിൽക്കുന്നു.',
      hi: 'घर की छत गिर गई। 5 लोगों के परिवार के पास कोई आश्रय नहीं है। छोटे बच्चों के साथ बाहर बारिश में खड़े हैं।',
      ta: 'வீட்டின் கூரை இடிந்தது. 5 பேர் கொண்ட குடும்பத்திற்கு தங்குமிடம் இல்லை. சிறு குழந்தைகளுடன் மழையில் வெளியே நிற்கின்றனர்.',
    },
    {
      en: 'Landslide destroyed our home completely. 8 people displaced. We need temporary shelter materials — tarpaulins, blankets, any help.',
      ml: 'ഉരുൾപൊട്ടൽ ഞങ്ങളുടെ വീട് പൂർണ്ണമായും നശിപ്പിച്ചു. 8 ആളുകൾ ഇടം മാറ്റപ്പെട്ടു. ഞങ്ങൾക്ക് താൽക്കാലിക അഭയ സാമഗ്രികൾ ആവശ്യം.',
      hi: 'भूस्खलन ने हमारे घर को पूरी तरह नष्ट कर दिया। 8 लोग विस्थापित हो गए हैं। हमें तिरपाल, कंबल जैसी अस्थायी आश्रय सामग्री चाहिए।',
      ta: 'நிலச்சரிவு எங்கள் வீட்டை முழுவதும் அழித்தது. 8 பேர் இடம்பெயர்ந்தனர். தார்பாலின், போர்வைகள் போன்ற தற்காலிக தங்குமிட பொருட்கள் தேவை.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Data generators
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randBool(probability: number): boolean {
  return Math.random() < probability;
}

function jitter(coord: number, maxDeltaDeg = 0.003): number {
  return coord + (Math.random() - 0.5) * 2 * maxDeltaDeg;
}

/** Weighted need type picker: 60% RESCUE, 20% FOOD, 10% MEDICINE, 10% SHELTER */
function pickNeedType(): keyof typeof DESCRIPTIONS {
  const r = Math.random();
  if (r < 0.60) return 'RESCUE';
  if (r < 0.80) return 'FOOD';
  if (r < 0.90) return 'MEDICINE';
  return 'SHELTER';
}

/** Pick one of the 4 languages based on Kerala demographics */
function pickLanguage(): 'en' | 'ml' | 'hi' | 'ta' {
  const r = Math.random();
  if (r < 0.55) return 'ml';   // Malayalam — dominant
  if (r < 0.75) return 'en';   // English — educated/NGO reporters
  if (r < 0.90) return 'hi';   // Hindi — migrant workers
  return 'ta';                  // Tamil — border district workers
}

const BCP47: Record<string, string> = { en: 'en', ml: 'ml', hi: 'hi', ta: 'ta' };

// ---------------------------------------------------------------------------
// Write helpers — batched Firestore writes (500 ops per batch)
// ---------------------------------------------------------------------------

async function writeBatch(
  ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }>,
): Promise<void> {
  const BATCH_SIZE = 400;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, data } of ops.slice(i, i + BATCH_SIZE)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
}

// ---------------------------------------------------------------------------
// Seed: DisasterEvent
// ---------------------------------------------------------------------------

async function seedDisasterEvent(): Promise<string> {
  const ref = db.collection('disasterEvents').doc(DISASTER_ID);
  const snap = await ref.get();
  if (snap.exists && snap.data()?.isDemoData) return DISASTER_ID;

  await ref.set({
    id:               DISASTER_ID,
    name:             'Kerala Flood 2018 — Simulation',
    type:             'FLOOD',
    severity:         'CATASTROPHIC',
    status:           'ACTIVE',
    phase:            'RESPONSE',
    affectedDistricts: ['Ernakulam', 'Wayanad', 'Idukki', 'Kottayam'],
    affectedStates:   ['Kerala'],
    boundingBox:      { north: 11.86, south: 9.50, east: 77.50, west: 75.70 },
    activatedAt:      Timestamp.fromDate(new Date('2018-08-15T06:00:00+05:30')),
    activatedBy:      'SYSTEM_AUTO',
    resolvedAt:       null,
    resolvedBy:       null,
    officialUrl:      'https://sdma.kerala.gov.in/',
    stats: {
      totalNeeds:             0,
      resolvedNeeds:          0,
      inProgressNeeds:        0,
      pendingNeeds:           0,
      activeVolunteers:       0,
      avgResponseTimeMinutes: null,
      totalReports:           0,
      resolutionRate:         null,
    },
    isDemoData: true,
    createdAt:  FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  });

  return DISASTER_ID;
}

// ---------------------------------------------------------------------------
// Seed: 200 RawReports (40 clusters × 5)
// ---------------------------------------------------------------------------

async function seedRawReports(): Promise<number> {
  // Check if already seeded.
  const check = await db.collection('rawReports')
    .where('isDemoData', '==', true)
    .limit(1).get();
  if (!check.empty) return 0;

  const ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
  const baseTime = new Date('2018-08-15T07:00:00+05:30').getTime();

  for (let cluster = 0; cluster < 40; cluster++) {
    const location  = FLOOD_LOCATIONS[cluster % FLOOD_LOCATIONS.length]!;
    const needType  = pickNeedType();
    const descBank  = DESCRIPTIONS[needType]!;
    const hasVuln   = randBool(0.15);
    const baseAff   = Math.floor(Math.random() * 8) + 1;

    for (let variant = 0; variant < 5; variant++) {
      const lang      = pickLanguage();
      const descSet   = pick(descBank);
      const description = descSet[lang];
      const originalLang = BCP47[lang]!;

      const lat = jitter(location.lat);
      const lng = jitter(location.lng);
      const offsetMs = cluster * 12 * 60 * 1000 + variant * 2 * 60 * 1000;

      const ref = db.collection('rawReports').doc();
      ops.push({
        ref,
        data: {
          id:                   ref.id,
          reporterId:           `demo-citizen-${String(cluster * 5 + variant).padStart(3, '0')}`,
          type:                 needType,
          description:          lang === 'en' ? description : descSet.en,
          originalDescription:  description,
          originalLanguage:     originalLang,
          voiceNoteUrl:         randBool(0.3) ? `https://storage.googleapis.com/rahatnet-demo/voice/demo-${cluster}-${variant}.webm` : null,
          photoUrls:            randBool(0.4) ? [pick(FLOOD_PHOTOS)] : [],
          location:             { lat, lng },
          locationName:         location.name,
          affectedCount:        Math.max(1, baseAff + Math.floor(Math.random() * 3)),
          hasVulnerable:        hasVuln,
          status:               'PENDING',
          canonicalNeedId:      null,
          disasterEventId:      DISASTER_ID,
          createdAt:            Timestamp.fromMillis(baseTime + offsetMs),
          isDemoData:           true,
        },
      });
    }
  }

  await writeBatch(ops);
  return ops.length;
}

// ---------------------------------------------------------------------------
// Seed: 20 Volunteer profiles
// ---------------------------------------------------------------------------

const VOLUNTEER_SKILLS_SETS: Array<string[]> = [
  ['BOAT_OPERATOR', 'RESCUE_SWIMMER'],
  ['BOAT_OPERATOR', 'DRIVER'],
  ['DOCTOR', 'NURSE'],
  ['NURSE'],
  ['DOCTOR'],
  ['COOK', 'DRIVER'],
  ['COOK'],
  ['CARPENTER', 'ELECTRICIAN'],
  ['ELECTRICIAN'],
  ['DRIVER', 'RESCUE_SWIMMER'],
  ['BOAT_OPERATOR'],
  ['COUNSELLOR'],
  ['TRANSLATOR', 'DRIVER'],
  ['RESCUE_SWIMMER'],
  ['NURSE', 'COUNSELLOR'],
  ['BOAT_OPERATOR', 'COOK'],
  ['CARPENTER'],
  ['DRIVER'],
  ['DOCTOR', 'TRANSLATOR'],
  ['ELECTRICIAN', 'CARPENTER'],
];

const VOLUNTEER_NAMES = [
  'Rajan Kumar',     'Priya Nair',       'Arun Mohan',       'Divya Krishnan',
  'Suresh Pillai',   'Meena Suresh',     'Babu George',      'Anitha Thomas',
  'Manoj Varghese',  'Sindhu Raj',       'Vijayan Nair',     'Sreelatha Menon',
  'Anil Kumar',      'Deepa Chandran',   'Binu John',        'Kavitha Sasi',
  'Sabu Abraham',    'Lekha Padmanabhan', 'Jomon Philip',    'Anjali Unni',
];

const DISTRICTS = ['Ernakulam', 'Wayanad', 'Idukki', 'Kottayam', 'Ernakulam'];

async function seedVolunteers(): Promise<number> {
  const check = await db.collection('users')
    .where('isDemoData', '==', true)
    .where('role', '==', 'VOLUNTEER')
    .limit(1).get();
  if (!check.empty) return 0;

  const ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];

  for (let i = 0; i < 20; i++) {
    const uid      = `demo-volunteer-${String(i + 1).padStart(2, '0')}`;
    const skills   = VOLUNTEER_SKILLS_SETS[i % VOLUNTEER_SKILLS_SETS.length]!;
    const district = DISTRICTS[i % DISTRICTS.length]!;
    const location = FLOOD_LOCATIONS.find((l) => l.district === district) ?? FLOOD_LOCATIONS[0]!;

    const ref = db.collection('users').doc(uid);
    ops.push({
      ref,
      data: {
        uid,
        phoneNumber:          `+919${String(876543210 + i).padStart(9, '0')}`,
        email:                null,
        displayName:          VOLUNTEER_NAMES[i]!,
        photoURL:             `https://api.dicebear.com/7.x/personas/svg?seed=vol${i}`,
        role:                 'VOLUNTEER',
        language:             i % 4 === 0 ? 'hi' : i % 4 === 1 ? 'ta' : 'ml',
        district,
        state:                'Kerala',
        fcmToken:             null,
        onboardingStatus:     'COMPLETED',
        notificationPreferences: null,
        skills,
        languages:            ['ml', 'en'],
        availabilityStatus:   'AVAILABLE',
        isAvailable:          true,
        verificationStatus:   'VERIFIED',
        activeAssignmentId:   null,
        stats: {
          tasksCompleted:          Math.floor(Math.random() * 15) + 2,
          completionRate:          0.85 + Math.random() * 0.15,
          averageRating:           4.0 + Math.random(),
          avgResponseTimeMinutes:  5 + Math.floor(Math.random() * 10),
          lastActiveAt:            new Date().toISOString(),
        },
        createdAt:  Timestamp.fromDate(new Date('2018-08-14T20:00:00+05:30')),
        updatedAt:  FieldValue.serverTimestamp(),
        isDemoData: true,
      },
    });
  }

  await writeBatch(ops);
  return ops.length;
}

// ---------------------------------------------------------------------------
// Seed: 5 Coordinator profiles
// ---------------------------------------------------------------------------

const COORDINATOR_NAMES = [
  'Dr. Sindhu Anand',   'Col. Ravi Nair',     'Ms. Leela Thomas',
  'Mr. Sunil Varma',    'Ms. Asha Krishnan',
];

async function seedCoordinators(): Promise<number> {
  const check = await db.collection('users')
    .where('isDemoData', '==', true)
    .where('role', '==', 'COORDINATOR')
    .limit(1).get();
  if (!check.empty) return 0;

  const ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];

  const orgs = [
    'Kerala Red Cross',
    'NDRF 6th Battalion',
    'Ernakulam District Collectorate',
    'Kerala Disaster Management Authority',
    'Caritas India',
  ];

  for (let i = 0; i < 5; i++) {
    const uid      = `demo-coordinator-${String(i + 1).padStart(2, '0')}`;
    const district = DISTRICTS[i]!;
    const ref = db.collection('users').doc(uid);
    ops.push({
      ref,
      data: {
        uid,
        phoneNumber:          `+919${String(876543230 + i).padStart(9, '0')}`,
        email:                `coord${i + 1}@rahatnet-demo.in`,
        displayName:          COORDINATOR_NAMES[i]!,
        photoURL:             `https://api.dicebear.com/7.x/personas/svg?seed=coord${i}`,
        role:                 'COORDINATOR',
        language:             'en',
        district,
        state:                'Kerala',
        fcmToken:             null,
        onboardingStatus:     'COMPLETED',
        notificationPreferences: null,
        organizationName:     orgs[i]!,
        designation:          'District Coordinator',
        managedDistricts:     [district],
        assignedDisasters:    [DISASTER_ID],
        createdAt:            Timestamp.fromDate(new Date('2018-08-14T18:00:00+05:30')),
        updatedAt:            FieldValue.serverTimestamp(),
        isDemoData:           true,
      },
    });
  }

  await writeBatch(ops);
  return ops.length;
}

// ---------------------------------------------------------------------------
// Seed: Resources
// ---------------------------------------------------------------------------

async function seedResources(): Promise<number> {
  const check = await db.collection('resources')
    .where('isDemoData', '==', true)
    .limit(1).get();
  if (!check.empty) return 0;

  const resources: Array<{ type: string; description: string; quantity: number; locationName: string; lat: number; lng: number }> = [];

  // 10 boats
  for (let i = 0; i < 10; i++) {
    const loc = FLOOD_LOCATIONS[i % 8]!;
    resources.push({
      type:         'BOAT',
      description:  `15-foot motorised country boat, 8-person capacity (Boat ${i + 1})`,
      quantity:     1,
      locationName: `${loc.district} Relief Staging Area`,
      lat:          loc.lat,
      lng:          loc.lng,
    });
  }

  // 500 food packets — 5 batches of 100
  for (let i = 0; i < 5; i++) {
    const loc = FLOOD_LOCATIONS[8 + i]!;
    resources.push({
      type:         'FOOD_PACKET',
      description:  `Pre-packed 1-day food parcel (rice, lentils, water) — Batch ${i + 1}`,
      quantity:     100,
      locationName: `${loc.district} Collection Point`,
      lat:          loc.lat,
      lng:          loc.lng,
    });
  }

  // 100 medicine kits — 2 batches of 50
  for (let i = 0; i < 2; i++) {
    const loc = FLOOD_LOCATIONS[16 + i]!;
    resources.push({
      type:         'MEDICINE_KIT',
      description:  `Emergency first aid + essential medicines kit (ORS, antibiotics, paracetamol, bandages) — Batch ${i + 1}`,
      quantity:     50,
      locationName: `${loc.district} Medical Camp`,
      lat:          loc.lat,
      lng:          loc.lng,
    });
  }

  const ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];

  for (const r of resources) {
    const ref = db.collection('resources').doc();
    ops.push({
      ref,
      data: {
        id:              ref.id,
        type:            r.type,
        description:     r.description,
        quantity:        r.quantity,
        deployed:        0,
        status:          'AVAILABLE',
        condition:       'GOOD',
        location:        { lat: r.lat, lng: r.lng },
        locationName:    r.locationName,
        assignedTo:      null,
        disasterEventId: DISASTER_ID,
        donorName:       pick(['Kerala CM Relief Fund', 'NDRF', 'Caritas India', 'Red Cross', null]),
        createdAt:       FieldValue.serverTimestamp(),
        updatedAt:       FieldValue.serverTimestamp(),
        isDemoData:      true,
      },
    });
  }

  await writeBatch(ops);
  return resources.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🌊  RahatNet Demo Seed — Kerala Flood 2018 Simulation\n');

  let spinner = await getSpinner('Creating disaster event…');
  await seedDisasterEvent();
  spinner.succeed('Disaster event: "Kerala Flood 2018 — Simulation"');

  spinner = await getSpinner('Seeding 200 raw reports (40 clusters × 5)…');
  const reports = await seedRawReports();
  spinner.succeed(reports > 0
    ? `Seeded ${reports} raw reports across 40 clusters`
    : 'Raw reports already exist — skipped');

  spinner = await getSpinner('Seeding 20 volunteer profiles…');
  const volunteers = await seedVolunteers();
  spinner.succeed(volunteers > 0
    ? `Seeded ${volunteers} volunteers across Ernakulam, Wayanad, Idukki, Kottayam`
    : 'Volunteers already exist — skipped');

  spinner = await getSpinner('Seeding 5 coordinator profiles…');
  const coordinators = await seedCoordinators();
  spinner.succeed(coordinators > 0
    ? `Seeded ${coordinators} coordinators`
    : 'Coordinators already exist — skipped');

  spinner = await getSpinner('Seeding resources (boats, food packets, medicine kits)…');
  const resources = await seedResources();
  spinner.succeed(resources > 0
    ? `Seeded ${resources} resource records (10 boats, 500 food packets, 100 medicine kits)`
    : 'Resources already exist — skipped');

  console.log('\n✅  Seeded 200 reports, 20 volunteers, 5 coordinators');
  console.log('   Disaster event ID:', DISASTER_ID);
  console.log('   All documents tagged isDemoData: true — use seed:clear to remove\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌  Seed script failed:', err);
  process.exit(1);
});
