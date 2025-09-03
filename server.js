// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const LOGIN_URL = 'https://gvdasa.maristas.org.br/apsweb/modulos/aluno/login.php5?'; // URL base do portal

app.use(helmet());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));

// session (usado apenas para curto tempo; troque secret em produção)
app.use(session({
  secret: process.env.SESSION_SECRET || 'troque_em_producao',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 5 * 60 * 1000 } // 5min
}));

// rate limiter para proteger endpoint de scraping
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 6,
  message: "Muitas requisições — aguarde 1 minuto."
});
app.use('/api/', limiter);

// endpoint que recebe credenciais e opcional meta (targetAverage)
app.post('/api/login-and-scrape', async (req, res) => {
  const { email, password, targetAverage, passingGrade } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Informe email e senha.'});
  }

  try {
    const data = await loginAndScrapeGrades({ email, password, targetAverage, passingGrade });
    return res.json({ success: true, data });
  } catch (err) {
    console.error('Erro scraping:', err);
    return res.status(500).json({ success: false, error: err.message || 'Erro interno' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

/**
 * loginAndScrapeGrades
 * - abre navegador (puppeteer)
 * - procura campos de login, select de unidade e escolhe "Marista Santo Ângelo" (ou item que contenha esse texto)
 * - faz o submit e navega até a página de notas (tenta encontrar link com texto 'Notas'/'Boletim'/'Avaliações')
 * - extrai tabela de notas (assume estruturas comuns: tabela com linhas: disciplina + avaliações)
 * - retorna objeto com array de disciplinas { name, grades: [{label, value, weight?}], currentAverage }
 */
async function loginAndScrapeGrades({ email, password, targetAverage = 7.0, passingGrade = 6.0 }) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(45000);

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    // 1) escolher a unidade - tenta localizar um select por vários nomes comuns
    const unitToSelect = 'Marista Santo Ângelo'; // texto parcial
    const selectHandles = await page.$$('select, select[name], select[id]');

    let unitSelected = false;
    for (const s of selectHandles) {
      const options = await s.$$eval('option', opts => opts.map(o => ({text: o.innerText, value: o.value})));
      const found = options.find(o => /marista santo angelo/i.test(o.text) || /8\s*\-\s*SOME/i.test(o.text) || /santo angelo/i.test(o.text));
      if (found) {
        await page.select(await s.evaluate(n=>n.getAttribute('name') || n.getAttribute('id') || ''), found.value).catch(()=>{});
        unitSelected = true;
        break;
      }
    }

    // fallback: if a select has options but we didn't pick, try selecting by url param lstUnidades if present
    if (!unitSelected) {
      // try direct navigation adding a guessed query param (some APS installations accept lstUnidades)
      // Not guaranteed; but often site respects lstUnidades param
      const tryUrl = LOGIN_URL + 'lstUnidades=8,Marista%20Santo%20%C3%82ngelo';
      try {
        await page.goto(tryUrl, { waitUntil: 'networkidle2' });
      } catch (e) {
        // ignore
      }
    }

    // 2) localizar campos de usuário e senha (tentativa robusta)
    const loginSelectors = [
      'input[name*=useri]',
      'input[name*=usuario]',
      'input[name*=matricula]',
      'input[name*=login]',
      'input[type="text"]'
    ];
    const passSelectors = [
      'input[name*=senha]',
      'input[name*=pass]',
      'input[type="password"]'
    ];

    let userInput = null;
    let passInput = null;

    for (const sel of loginSelectors) {
      const el = await page.$(sel);
      if (el) { userInput = el; break; }
    }
    for (const sel of passSelectors) {
      const el = await page.$(sel);
      if (el) { passInput = el; break; }
    }

    // se não encontrou, tenta heurística: primeiro input text e first password
    if (!userInput) {
      const textInputs = await page.$$('input[type="text"], input:not([type])');
      if (textInputs.length) userInput = textInputs[0];
    }
    if (!passInput) {
      const pws = await page.$$('input[type="password"]');
      if (pws.length) passInput = pws[0];
    }

    if (!userInput || !passInput) {
      throw new Error('Não foi possível localizar campos de login na página — o layout pode ter mudado.');
    }

    // digita credenciais (sem logar nos consoles)
    await userInput.click({clickCount: 3});
    await userInput.type(email, {delay: 30});
    await passInput.click({clickCount: 3});
    await passInput.type(password, {delay: 30});

    // 3) localizar botão de submit
    const submitSelectors = ['input[type=submit]', 'button[type=submit]', 'button:contains("Entrar")', 'a.btn'];
    let submitted = false;

    // try to submit form enclosing the inputs
    try {
      await Promise.all([
        page.evaluate(() => {
          // tenta submeter o primeiro form da página
          const f = document.querySelector('form');
          if (f) f.submit();
        }),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
      ]);
      submitted = true;
    } catch (_) {
      // fallback: try click common buttons
    }

    if (!submitted) {
      // tenta clicar em algum botão visível
      const candidates = await page.$$('input[type=submit], button[type=submit], button');
      for (const c of candidates) {
        const txt = (await page.evaluate(el => el.innerText || el.value || '', c)).toLowerCase();
        if (txt.includes('entrar') || txt.includes('acessar') || txt.includes('login') || txt.includes('entrar')) {
          try {
            await Promise.all([c.click(), page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })]);
            submitted = true;
            break;
          } catch (e) {
            // continue
          }
        }
      }
    }

    if (!submitted) {
      // última tentativa: pressione Enter no campo de senha
      try {
        await passInput.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        submitted = true;
      } catch (e) { /* ignore */ }
    }

    // Se login falhou: verificação simples de presença de texto "Usuário ou senha inválidos" ou permanência na mesma URL
    const currentUrl = page.url();
    if (!submitted || /login/i.test(currentUrl)) {
      // tenta detectar mensagem de erro
      const bodyText = await page.evaluate(()=>document.body.innerText || '');
      if (/(usu[aá]rio|senha).*(inv[aá]lido|incorreto)|erro de login|senha incorreta/i.test(bodyText)) {
        throw new Error('Falha de autenticação: verifique usuário e senha.');
      }
      // else não conseguiu navegar mas não encontrou erro claro - continua tentando
    }

    // 4) localizar página de notas — procuramos links com textos comuns
    const linkTexts = ['nota','notas','boletim','avalia','avaliac','avalição','avaliações'];
    let gradesPageFound = false;
    let gradesPageUrl = null;
    const anchors = await page.$$('a');
    for (const a of anchors) {
      const tx = (await page.evaluate(el => el.innerText || '', a)).toLowerCase();
      if (linkTexts.some(k => tx.includes(k))) {
        // clique e espere
        try {
          await Promise.all([a.click(), page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 })]);
          gradesPageFound = true;
          gradesPageUrl = page.url();
          break;
        } catch (e) {
          // tentar obter href e navegar direto
          const href = await page.evaluate(el => el.href || '', a);
          if (href) {
            try {
              await page.goto(href, { waitUntil: 'networkidle2' });
              gradesPageFound = true;
              gradesPageUrl = page.url();
              break;
            } catch (e2) { /* ignore */ }
          }
        }
      }
    }

    if (!gradesPageFound) {
      // fallback: tenta URLs padrão do apsweb que costumam conter /boletim ou /avaliacao
      const tryPaths = ['/modulos/aluno/boletim.php5', '/modulos/aluno/avaliacao.php5', '/modulos/aluno/notas.php5'];
      for (const p of tryPaths) {
        try {
          await page.goto(new URL(p, LOGIN_URL).toString(), { waitUntil: 'networkidle2' });
          const body = await page.evaluate(()=>document.body.innerText || '');
          if (/(disciplin|nota|avalia)/i.test(body)) {
            gradesPageFound = true;
            gradesPageUrl = page.url();
            break;
          }
        } catch (e) {}
      }
    }

    if (!gradesPageFound) {
      throw new Error('Não foi possível localizar a página de notas automaticamente. O layout do portal pode ser diferente.');
    }

    // 5) extrair notas da(s) tabela(s)
    // heurística: procurar por tabelas com palavras-chaves de disciplina/nota
    const gradesData = await page.evaluate(() => {
      const extractNumber = str => {
        if (!str && str !== 0) return null;
        const s = String(str).replace(',', '.');
        const m = s.match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
      };

      const results = [];
      // procurar tabelas na página
      const tables = Array.from(document.querySelectorAll('table'));
      tables.forEach(table => {
        const headers = Array.from(table.querySelectorAll('th')).map(n => n.innerText.toLowerCase());
        const text = table.innerText.toLowerCase();
        // heurística rápida: se houver palavras disciplina/nota/média
        if (headers.some(h => /disciplin|disciplina|mat[rí]a|materia/i.test(h)) || /disciplin|nota|m[eé]dia|avalia/i.test(text)) {
          const rows = Array.from(table.querySelectorAll('tr'));
          rows.forEach((tr, idx) => {
            // pular header row
            if (idx === 0 && tr.querySelectorAll('th').length) return;
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
            if (cells.length >= 2) {
              const name = cells[0];
              // tentar extrair números das outras células
              const gradeCells = cells.slice(1).map(c => ({ raw: c, val: extractNumber(c) }));
              const numericVals = gradeCells.map(c=>c.val).filter(v=>v !== null);
              // calcular média simples se existirem números
              const avg = numericVals.length ? numericVals.reduce((a,b)=>a+b,0)/numericVals.length : null;
              results.push({
                name,
                rawRow: cells,
                grades: gradeCells,
                currentAverage: avg
              });
            }
          });
        }
      });

      // se não encontrou nada, tentar parse alternativo: procurar por linhas com "Disciplina" no texto
      if (!results.length) {
        const text = document.body.innerText;
        const lines = text.split('\\n').map(l=>l.trim()).filter(Boolean);
        for (let i=0;i<lines.length;i++) {
          const l = lines[i];
          if (/disciplina|matéria|materia/i.test(l) && i+1 < lines.length) {
            // tenta pegar próximas 5 linhas
            results.push({ name: l, rawRow: [lines[i], lines[i+1]], grades: [], currentAverage: null });
          }
        }
      }

      return results;
    });

    // 6) organiza e calcula piores notas e quanto falta para meta
    // assumptions: currentAverage null -> no numeric data
    const subjects = gradesData.map(s => {
      return {
        name: s.name,
        grades: s.grades.map(g => ({ raw: g.raw, value: g.val })),
        currentAverage: s.currentAverage
      };
    }).filter(s => s.name && s.name.trim());

    // ordenar por média asc (piores primeiro)
    const subjectsWithAvg = subjects.map(s => ({...s, avg: s.currentAverage}));
    const sortedByWorst = subjectsWithAvg.slice().sort((a,b) => {
      const aVal = a.avg !== null ? a.avg : Infinity;
      const bVal = b.avg !== null ? b.avg : Infinity;
      return aVal - bVal;
    });

    // cálculo necessário para atingir targetAverage (assume media simples e que existe 1 avaliação restante com peso igual,
    // or if no remaining assessment info available, estimativa)
    function estimateNeededToTarget(subject, target) {
      // if subject.avg is null -> unknown
      if (subject.avg === null || subject.avg === undefined) return { possible: false, reason: 'Sem média disponível' };
      // assume there are N grades currently (k) representing completed assessments,
      // and there's 1 remaining assessment with same weight -> newAvg = (sum + x)/(k+1)
      const numeric = subject.grades.map(g => g.value).filter(v => typeof v === 'number' && !isNaN(v));
      const k = numeric.length;
      const sum = numeric.reduce((a,b)=>a+b,0);
      // if k===0, we can't compute reliably; assume 1 remaining (final) -> need target
      if (k === 0) {
        // need x such that x = target (single grade) -> best guess
        return { possible: true, requiredOnNext: target, formula: 'Sem notas anteriores, necessário alcançar a própria meta na avaliação restante' };
      }
      // required x: (sum + x) / (k+1) >= target  => x >= target*(k+1) - sum
      const requiredX = target * (k + 1) - sum;
      const capped = Math.min(Math.max(requiredX, 0), 10); // assumindo escala 0-10
      return { possible: true, requiredOnNext: requiredX, requiredOnNextCapped: capped, formula: `x >= ${target}*(${k+1}) - ${sum}` };
    }

    const worstWithNeeds = sortedByWorst.map(s => {
      const need = estimateNeededToTarget(s, parseFloat(targetAverage));
      return { ...s, needToReachTarget: need };
    });

    // prepare final result
    const final = {
      scrapedAt: new Date().toISOString(),
      gradesPageUrl,
      subjects,
      worstOrdered: worstWithNeeds,
      stats: {
        countSubjects: subjects.length,
        targetAverage: parseFloat(targetAverage),
        passingGrade: parseFloat(passingGrade)
      }
    };

    // cleanup: close page & browser
    await page.close();
    await browser.close();

    return final;
  } catch (err) {
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}
