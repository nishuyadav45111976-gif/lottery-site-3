// Quick Ticket Entry — shared by the Admin Dashboard, a lottery's own
// purchase-entry page, and the staff panel.
//
// Typed format:   10,11,12,13,51,71,78,98×75 into Rewari
//   - numbers, separated by commas and/or spaces, in any mix (00-99)
//   - × (or x / X / *, repeated or with stray spaces is fine) then the
//     amount, applied to EACH number
//   - optional "into <lottery name>" — required unless the page already
//     knows which lottery this is for (e.g. a lottery's own purchase page),
//     in which case typing "into <name>" still overrides it. Small typos
//     in the name (e.g. "Rewadi" for "Rewari") are matched to the closest
//     lottery name automatically.
//
// Each number becomes its own internal ticket record (1 ticket, no buyer
// name) via POST /admin/quick-purchase.
(function () {
  var box = document.getElementById('quickAdminEntry');
  if (!box) return;

  var input = document.getElementById('quickAdminInput');
  var submitBtn = document.getElementById('quickAdminSubmit');
  var errorEl = document.getElementById('quickAdminError');
  var form = document.getElementById('quickAdminForm');
  var lotteryIdField = document.getElementById('quickAdminLotteryId');
  var amountField = document.getElementById('quickAdminAmount');
  var numbersHost = document.getElementById('quickAdminNumbersInputs');

  var defaultLotteryId = box.getAttribute('data-lottery-id') || '';

  var lotteries = [];
  var lotteriesDataEl = document.getElementById('quickAdminLotteriesData');
  if (lotteriesDataEl) {
    try { lotteries = JSON.parse(lotteriesDataEl.textContent) || []; } catch (e) { lotteries = []; }
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  // Classic edit-distance: how many single-character insert/delete/swap
  // steps to turn `a` into `b`. Used to catch typos like "Rewadi" ->
  // "Rewari" that a plain substring match would miss.
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    var prev = new Array(n + 1);
    var curr = new Array(n + 1);
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      curr[0] = i;
      for (var k = 1; k <= n; k++) {
        var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
        curr[k] = Math.min(prev[k] + 1, curr[k - 1] + 1, prev[k - 1] + cost);
      }
      for (var x = 0; x <= n; x++) prev[x] = curr[x];
    }
    return prev[n];
  }

  function resolveLottery(typedName) {
    var needle = typedName.trim().toLowerCase();
    var exact = lotteries.filter(function (l) { return l.name.toLowerCase() === needle; });
    if (exact.length === 1) return exact[0];

    var startsWith = lotteries.filter(function (l) { return l.name.toLowerCase().indexOf(needle) === 0; });
    if (startsWith.length === 1) return startsWith[0];

    var includes = lotteries.filter(function (l) { return l.name.toLowerCase().indexOf(needle) !== -1; });
    if (includes.length === 1) return includes[0];
    if (includes.length > 1) {
      return { ambiguous: includes.map(function (l) { return l.name; }) };
    }

    // Nothing exact/partial matched — fall back to closest-spelling match,
    // to forgive small typos like "Rewadi"/"Rewarii" for "Rewari".
    if (!lotteries.length) return null;
    var scored = lotteries.map(function (l) {
      var name = l.name.toLowerCase();
      var dist = levenshtein(needle, name);
      return { lottery: l, dist: dist, tolerance: Math.max(2, Math.round(Math.max(needle.length, name.length) * 0.34)) };
    }).filter(function (s) { return s.dist <= s.tolerance; })
      .sort(function (a, b) { return a.dist - b.dist; });

    if (!scored.length) return null;
    if (scored.length > 1 && scored[0].dist === scored[1].dist) {
      return { ambiguous: scored.filter(function (s) { return s.dist === scored[0].dist; }).map(function (s) { return s.lottery.name; }) };
    }
    return scored[0].lottery;
  }

  function handleSubmit() {
    errorEl.style.display = 'none';
    var raw = (input.value || '').trim();
    if (!raw) { showError('Type something like: 10,11,12×75 into Rewari'); return; }

    var lotteryId = defaultLotteryId;
    var mainPart = raw;

    var intoMatch = raw.split(/\binto\b/i);
    if (intoMatch.length >= 2) {
      mainPart = intoMatch[0].trim();
      var typedName = intoMatch.slice(1).join('into').trim();
      if (!typedName) { showError('Enter a lottery name after "into".'); return; }
      var found = resolveLottery(typedName);
      if (!found) { showError('No lottery named "' + typedName + '" found.'); return; }
      if (found.ambiguous) { showError('"' + typedName + '" matches more than one lottery: ' + found.ambiguous.join(', ') + '. Type more of the name.'); return; }
      lotteryId = found.id;
    }

    if (!lotteryId) {
      showError('Add "into <lottery name>" to say which lottery this is for.');
      return;
    }

    // Split on ×/x/X/*, tolerating repeats and stray spaces around it
    // (e.g. "12 xx 100", "12  x  100").
    var pieces = mainPart.split(/\s*[×xX*]+\s*/);
    if (pieces.length !== 2) {
      showError('Use the format: 10,11,12×75 (numbers × amount)');
      return;
    }
    var numbersPart = pieces[0].trim();
    var amountPart = pieces[1].trim();
    var amount = parseFloat(amountPart);
    if (!isFinite(amount) || amount < 0) {
      showError('Enter a valid amount after ×.');
      return;
    }

    // Numbers may be separated by commas, spaces, or a mix of both, with
    // any amount of extra whitespace ("1, 2 3,  4").
    var rawNumbers = numbersPart.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var numbers = [];
    for (var i = 0; i < rawNumbers.length; i++) {
      var s = rawNumbers[i];
      if (!/^\d{1,2}$/.test(s)) { showError('"' + s + '" is not a valid number (00-99).'); return; }
      numbers.push(s.padStart(2, '0'));
    }
    if (!numbers.length) { showError('Enter at least one number before ×.'); return; }
    if (numbers.length > 100) { showError('Too many numbers in one entry (max 100).'); return; }

    lotteryIdField.value = lotteryId;
    amountField.value = amount;
    numbersHost.innerHTML = '';
    numbers.forEach(function (n) {
      var hidden = document.createElement('input');
      hidden.type = 'hidden'; hidden.name = 'numbers'; hidden.value = n;
      numbersHost.appendChild(hidden);
    });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
    form.submit();
  }

  submitBtn.addEventListener('click', handleSubmit);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
  });
})();

