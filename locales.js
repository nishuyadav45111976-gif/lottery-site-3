// Simple translation dictionary for the public-facing pages. Not used on the
// admin panel, which stays English-only. Add a key to both languages here,
// then use t('key') in a view.

const translations = {
  en: {
    navResults: 'Results',
    navHistory: 'Full History',
    langToggle: 'हिंदी',

    tagline: "Tap a lottery name to see its full result history.",
    lastUpdatedLabel: 'Last updated',
    featuredLabel: 'Featured',
    mainResultsHeading: 'Main Results',
    noResultYet: 'No result yet',
    emptyLotteries: 'No lotteries have been added yet. Check back soon.',
    searchPlaceholder: 'Search lottery by name…',
    noSearchResults: 'No lotteries match your search.',
    tableLottery: 'Lottery',
    tableTime: 'Time',
    tablePrevious: 'Previous',
    tableLatest: 'Latest',
    last15Heading: 'Last 15 Days — All Lotteries',
    last15Sub: 'Scroll down to see more dates, scroll sideways on small screens to see every lottery.',
    viewFullHistory: 'View the full combined history chart →',

    lotteryBackAll: '← All lotteries',
    lotterySubtitle: 'Full result history, most recent first.',
    lotteryEmpty: 'No results have been posted for this lottery yet.',
    colDate: 'Date',
    colResult: 'Result',

    historyBackLatest: '← Back to latest results',
    historyHeading: 'Full Result History',
    historySubtitle: 'Every lottery, every date, in one chart.',
    filterLotteryLabel: 'Lottery',
    filterAllLotteries: 'All lotteries',
    filterFromLabel: 'From date',
    filterToLabel: 'To date',
    filterButton: 'Filter',
    clearFilters: 'Clear filters',
    historyEmptyNoLotteries: 'No lotteries have been added yet.',
    historyEmptyNoMatch: 'No results match these filters.',

    notFoundTitle: 'Page Not Found',
    notFoundText: "That lottery or page doesn't exist.",
    notFoundBackHome: '← Back to homepage',
  },
  hi: {
    navResults: 'परिणाम',
    navHistory: 'पूरा इतिहास',
    langToggle: 'English',

    tagline: 'पूरा परिणाम इतिहास देखने के लिए लॉटरी के नाम पर टैप करें।',
    lastUpdatedLabel: 'आख़िरी अपडेट',
    featuredLabel: 'फ़ीचर्ड',
    mainResultsHeading: 'मुख्य परिणाम',
    noResultYet: 'अभी तक कोई परिणाम नहीं',
    emptyLotteries: 'अभी तक कोई लॉटरी नहीं जोड़ी गई है। कृपया बाद में देखें।',
    searchPlaceholder: 'लॉटरी का नाम खोजें…',
    noSearchResults: 'आपकी खोज से कोई लॉटरी मेल नहीं खाती।',
    tableLottery: 'लॉटरी',
    tableTime: 'समय',
    tablePrevious: 'पिछला',
    tableLatest: 'नवीनतम',
    last15Heading: 'पिछले 15 दिन — सभी लॉटरी',
    last15Sub: 'और तारीखें देखने के लिए नीचे स्क्रॉल करें, छोटी स्क्रीन पर सभी लॉटरी देखने के लिए बग़ल में स्क्रॉल करें।',
    viewFullHistory: 'पूरा संयुक्त इतिहास चार्ट देखें →',

    lotteryBackAll: '← सभी लॉटरी',
    lotterySubtitle: 'पूरा परिणाम इतिहास, सबसे नया सबसे पहले।',
    lotteryEmpty: 'इस लॉटरी के लिए अभी तक कोई परिणाम पोस्ट नहीं किया गया है।',
    colDate: 'तारीख',
    colResult: 'परिणाम',

    historyBackLatest: '← नवीनतम परिणामों पर वापस जाएं',
    historyHeading: 'पूरा परिणाम इतिहास',
    historySubtitle: 'हर लॉटरी, हर तारीख, एक ही चार्ट में।',
    filterLotteryLabel: 'लॉटरी',
    filterAllLotteries: 'सभी लॉटरी',
    filterFromLabel: 'से तारीख',
    filterToLabel: 'तक तारीख',
    filterButton: 'फ़िल्टर करें',
    clearFilters: 'फ़िल्टर हटाएं',
    historyEmptyNoLotteries: 'अभी तक कोई लॉटरी नहीं जोड़ी गई है।',
    historyEmptyNoMatch: 'इन फ़िल्टर से कोई परिणाम मेल नहीं खाता।',

    notFoundTitle: 'पेज नहीं मिला',
    notFoundText: 'वह लॉटरी या पेज मौजूद नहीं है।',
    notFoundBackHome: '← होमपेज पर वापस जाएं',
  },
};

function translator(lang) {
  const dict = translations[lang] || translations.en;
  return function t(key) {
    return dict[key] || translations.en[key] || key;
  };
}

module.exports = { translations, translator };
