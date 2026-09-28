import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';

// Explicitly register TeX packages
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/cases/CasesConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js';
import 'mathjax-full/js/input/tex/noerrors/NoerrorsConfiguration.js';
import 'mathjax-full/js/input/tex/noundefined/NoundefinedConfiguration.js';
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js';
import 'mathjax-full/js/input/tex/braket/BraketConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';
import 'mathjax-full/js/input/tex/centernot/CenternotConfiguration.js';
import 'mathjax-full/js/input/tex/extpfeil/ExtpfeilConfiguration.js';
import 'mathjax-full/js/input/tex/textmacros/TextmacrosConfiguration.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const packages = [
  'base',
  'ams',
  'cases',
  'boldsymbol',
  'newcommand',
  'mathtools',
  'noerrors',
  'noundefined',
  'physics',
  'braket',
  'cancel',
  'centernot',
  'extpfeil',
  'textmacros'
];

const tex = new TeX({ packages });
const svg = new SVG({ fontCache: 'local' });
const html = mathjax.document('', { InputJax: tex, OutputJax: svg });

export function renderMath(formula: string, display: boolean = false): string {
  try {
    const node = html.convert(formula, { display });
    return adaptor.outerHTML(node);
  } catch (err: any) {
    const safeMsg = String(err?.message || 'Math rendering error').replace(/"/g, '&quot;');
    const safeFormula = String(formula).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="math-error" title="${safeMsg}">${safeFormula}</span>`;
  }
}
