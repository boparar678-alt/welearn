(function (global) {
  'use strict';

  const LETTERS = 'ABCDEF';

  function parseCSV(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = String(text || '').replace(/^\uFEFF/, '');

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          row.push(field);
          field = '';
        } else if (ch === '\r') {
          if (s[i + 1] === '\n') i++;
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else if (ch === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((cell) => String(cell ?? '').trim() !== ''));
  }

  function detectDelimiter(text) {
    const firstLine = String(text || '').split(/\r?\n/)[0] || '';
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    return tabs > commas ? '\t' : ',';
  }

  function normalizeHeader(h) {
    return String(h || '')
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function detectColumns(headerRow) {
    const map = {
      q: -1,
      options: [-1, -1, -1, -1, -1, -1],
      answer: -1,
      time: -1,
      image: -1,
      explanation: -1,
    };

    headerRow.forEach((raw, idx) => {
      const h = normalizeHeader(raw);
      if (!h) return;
      if (map.q === -1 && /^(question|q|prompt|question text)$/.test(h)) {
        map.q = idx;
      } else if (/^(option|opt|choice)?\s*a$|^option 1$|^choice 1$/.test(h)) {
        map.options[0] = idx;
      } else if (/^(option|opt|choice)?\s*b$|^option 2$|^choice 2$/.test(h)) {
        map.options[1] = idx;
      } else if (/^(option|opt|choice)?\s*c$|^option 3$|^choice 3$/.test(h)) {
        map.options[2] = idx;
      } else if (/^(option|opt|choice)?\s*d$|^option 4$|^choice 4$/.test(h)) {
        map.options[3] = idx;
      } else if (/^(option|opt|choice)?\s*e$|^option 5$|^choice 5$/.test(h)) {
        map.options[4] = idx;
      } else if (/^(option|opt|choice)?\s*f$|^option 6$|^choice 6$/.test(h)) {
        map.options[5] = idx;
      } else if (map.answer === -1 && /^(answer|ans|correct|correct answer|key|answer key)$/.test(h)) {
        map.answer = idx;
      } else if (map.time === -1 && /^(time|seconds|sec|duration|timer)$/.test(h)) {
        map.time = idx;
      } else if (map.image === -1 && /^(image|img|image url|img url|picture)$/.test(h)) {
        map.image = idx;
      } else if (map.explanation === -1 && /^(explanation|explain|reason|note|notes)$/.test(h)) {
        map.explanation = idx;
      }
    });

    const hasHeader = map.q !== -1 && map.options.some((i) => i !== -1);
    return { hasHeader, map };
  }

  function resolveAnswerToken(token, options) {
    const raw = String(token ?? '').trim();
    if (!raw) return -1;
    const upper = raw.toUpperCase();
    if (/^[A-F]$/.test(upper)) {
      const idx = LETTERS.indexOf(upper);
      return idx < options.length ? idx : -1;
    }
    if (/^[1-6]$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;
      return idx < options.length ? idx : -1;
    }
    const lower = raw.toLowerCase();
    const matchIdx = options.findIndex((o) => o.toLowerCase() === lower);
    return matchIdx;
  }

  function parseAnswerKeyOverrides(text) {
    const overrides = new Map();
    const raw = String(text || '').trim();
    if (!raw) return overrides;

    // Supports "1-B, 2-A, 3-D" or "1: B; 2: A" or one token per line ("B\nA\nD")
    const numberedMatches = raw.match(/\d+\s*[-:.)]\s*[A-Za-z0-9]+/g);
    if (numberedMatches && numberedMatches.length > 0 && !/^[A-Fa-f1-6]$/.test(raw.split(/\r?\n/)[0].trim())) {
      for (const m of numberedMatches) {
        const parts = m.match(/^(\d+)\s*[-:.)]\s*(.+)$/);
        if (parts) {
          overrides.set(parseInt(parts[1], 10), parts[2].trim());
        }
      }
      return overrides;
    }

    // Fallback: split by lines or commas as sequential 1..N
    const tokens = raw
      .split(/[\r\n,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    tokens.forEach((tok, idx) => {
      const numbered = tok.match(/^(\d+)\s*[-:.)]\s*(.+)$/);
      if (numbered) {
        overrides.set(parseInt(numbered[1], 10), numbered[2].trim());
      } else {
        overrides.set(idx + 1, tok);
      }
    });
    return overrides;
  }

  function rowsToQuestions(rows, answerKeyText) {
    if (!rows || rows.length === 0) {
      return { questions: [], errors: [], totalRows: 0 };
    }

    const { hasHeader, map } = detectColumns(rows[0]);
    const startIdx = hasHeader ? 1 : 0;
    const overrides = parseAnswerKeyOverrides(answerKeyText);

    const questions = [];
    const errors = [];

    for (let r = startIdx; r < rows.length; r++) {
      const row = rows[r];
      const qNum = questions.length + 1;
      const rowLabel = `Row ${r + 1}`;

      let qText = '';
      let rawOptions = [];
      let ansToken = '';
      let timeVal = '';
      let imageVal = '';
      let explanationVal = '';

      if (hasHeader) {
        qText = String(row[map.q] ?? '').trim();
        rawOptions = map.options.map((idx) => (idx >= 0 ? String(row[idx] ?? '').trim() : ''));
        ansToken = map.answer >= 0 ? String(row[map.answer] ?? '').trim() : '';
        timeVal = map.time >= 0 ? String(row[map.time] ?? '').trim() : '';
        imageVal = map.image >= 0 ? String(row[map.image] ?? '').trim() : '';
        explanationVal = map.explanation >= 0 ? String(row[map.explanation] ?? '').trim() : '';
      } else {
        // Positional fallback: Q, OptA, OptB, OptC, OptD, [OptE, OptF], Answer, Time, Image, Explanation
        qText = String(row[0] ?? '').trim();
        rawOptions = [row[1], row[2], row[3], row[4]].map((v) => String(v ?? '').trim());
        ansToken = String(row[5] ?? '').trim();
        timeVal = String(row[6] ?? '').trim();
        imageVal = String(row[7] ?? '').trim();
        explanationVal = String(row[8] ?? '').trim();
      }

      const options = rawOptions.filter(Boolean);
      const overrideTok = overrides.get(qNum);
      if (overrideTok !== undefined) {
        ansToken = overrideTok;
      }

      const rowErrors = [];
      if (!qText) rowErrors.push('Question text is empty');
      if (options.length < 2) rowErrors.push('Needs at least 2 options');
      if (options.length > 6) rowErrors.push('Maximum 6 options');

      const answer = resolveAnswerToken(ansToken, options);
      if (answer < 0 || answer >= options.length) {
        rowErrors.push(ansToken ? `Invalid answer "${ansToken}"` : 'Missing answer key');
      }

      let time = null;
      if (timeVal) {
        const parsedTime = parseInt(timeVal, 10);
        if (!Number.isFinite(parsedTime) || parsedTime < 5 || parsedTime > 600) {
          rowErrors.push('Time must be 5-600s');
        } else {
          time = parsedTime;
        }
      }

      if (rowErrors.length > 0) {
        errors.push(`${rowLabel} (Q${qNum}): ${rowErrors.join('; ')}`);
      }

      questions.push({
        q: qText,
        options,
        answer,
        time,
        image: imageVal,
        explanation: explanationVal,
        _rowNum: r + 1,
        _errors: rowErrors,
      });
    }

    if (questions.length > 2000) {
      errors.push('Maximum 2000 questions per quiz.');
    }

    return { questions, errors, totalRows: rows.length - startIdx };
  }

  function parseText(text, answerKeyText) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { questions: [], errors: [], totalRows: 0 };
    const delim = detectDelimiter(trimmed);
    const rows = parseCSV(trimmed, delim);
    return rowsToQuestions(rows, answerKeyText);
  }

  async function parseFile(file, answerKeyText) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      if (!global.XLSX) {
        throw new Error('Excel parser failed to load. Please upload a CSV file or paste rows from Excel.');
      }
      const buf = await file.arrayBuffer();
      const wb = global.XLSX.read(buf, { type: 'array' });
      const firstSheet = wb.SheetNames[0];
      if (!firstSheet) throw new Error('The workbook has no sheets.');
      const rows = global.XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1, defval: '' });
      const filtered = rows.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
      return {
        rawRows: filtered,
        ...rowsToQuestions(filtered, answerKeyText),
      };
    }

    const text = await file.text();
    return {
      rawText: text,
      ...parseText(text, answerKeyText),
    };
  }

  global.QuizParser = {
    LETTERS,
    parseText,
    parseFile,
    rowsToQuestions,
    parseAnswerKeyOverrides,
  };
})(window);
