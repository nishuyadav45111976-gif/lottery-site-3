// Quick Ticket Entry — User Dashboard version.
// Same typed format as the Admin Dashboard's Quick Ticket Entry
// (see public/admin-quick-entry.js), so it's kept as its own file rather
// than sharing element ids with the admin box.
//
// Typed format:   10,11,12,13,51,71,78,98×75 into Rewari
//   - numbers, separated by commas and/or spaces, in any mix (00-99)
//   - × (or x / X / *, repeated or with stray spaces is fine) then the
//     amount, applied to EACH number
//   - a lottery name after the amount — the word "into" is optional, so
//     "10,11×75 into Rewari" and "10,11×75 Rewari" both work. Small typos
//     (e.g. "Rewadi" for "Rewari") are matched to the closest lottery
//     name automatically.
//
// Each number becomes its own ticket record under the signed-in user's
// account (1 ticket each, buyer name taken from the account) via
// POST /account/quick-purchase.
(function () {
  var box = document.getElementById('quickUserEntry');
  if (!box) return;

  var input = document.getElementById('quickUserInput');
  var submitBtn = document.getElementById('quickUserSubmit');
  var errorEl = document.getElementById('quickUserError');
  var form = document.getElementById('quickUserForm');
  var lotteryIdField = document.getElementById('quickUserLotteryId');
  var amountField = document.getElementById('quickUserAmount');
  var numbersHost = document.getElementById('quickUserNumbersInputs');

  var digits = 2;
  var maxValueLabel = '00-99';

  var lotteries = [];
  var lotteriesDataEl = document.getElementById('quickUserLotteriesData');
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
    if (!raw) { showError('Type something like: 10,11,12×75 Rewari'); return; }

    var lotteryId = '';
    var mainPart = raw;
    var typedName = null;

    // "into <name>" still works if typed, but is no longer required — any
    // text after the amount is treated as the lottery name.
    var intoMatch = raw.split(/\binto\b/i);
    if (intoMatch.length >= 2) {
      mainPart = intoMatch[0].trim();
      typedName = intoMatch.slice(1).join('into').trim();
      if (!typedName) { showError('Enter a lottery name after "into".'); return; }
    }

    // Split on the FIRST run of ×/x/X/* only — using an anchored match
    // instead of a global split, so a lottery name that happens to
    // contain the letter "x" doesn't get mistaken for another separator.
    var splitMatch = mainPart.match(/^([\d,\s]+)[×xX*]+(.*)$/);
    if (!splitMatch) {
      showError('Use the format: 10,11,12×75 (numbers × amount)');
      return;
    }
    var numbersPart = splitMatch[1].trim();
    var afterAmount = splitMatch[2].trim();

    // Pull the leading number off as the amount; anything left over (when
    // "into" wasn't used) is taken as the lottery name.
    var amountMatch = afterAmount.match(/^([\d.]+)\s*(.*)$/);
    if (!amountMatch) {
      showError('Enter a valid amount after ×.');
      return;
    }
    var amount = parseFloat(amountMatch[1]);
    if (!isFinite(amount) || amount < 0) {
      showError('Enter a valid amount after ×.');
      return;
    }
    if (typedName === null && amountMatch[2]) {
      typedName = amountMatch[2].trim();
    }

    if (!typedName) {
      showError('Add the lottery name after the amount to say which lottery this is for.');
      return;
    }
    var found = resolveLottery(typedName);
    if (!found) { showError('No lottery named "' + typedName + '" found.'); return; }
    if (found.ambiguous) { showError('"' + typedName + '" matches more than one lottery: ' + found.ambiguous.join(', ') + '. Type more of the name.'); return; }
    lotteryId = found.id;

    // Numbers may be separated by commas, spaces, or a mix of both, with
    // any amount of extra whitespace ("1, 2 3,  4").
    var rawNumbers = numbersPart.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var numbers = [];
    for (var i = 0; i < rawNumbers.length; i++) {
      var s = rawNumbers[i];
      if (!new RegExp('^\\d{1,' + digits + '}$').test(s)) { showError('"' + s + '" is not a valid number (' + maxValueLabel + ').'); return; }
      numbers.push(s.padStart(digits, '0'));
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
