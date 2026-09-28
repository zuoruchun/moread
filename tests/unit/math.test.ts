import { describe, it, expect } from 'vitest';
import { renderMath } from '../../src/renderer/modules/math.ts';

describe('MathJax LaTeX Math Rendering', () => {
  it('should render inline fraction', () => {
    const svg = renderMath('\\frac{a}{b}', false);
    expect(svg).toContain('<svg');
    expect(svg).toContain('class="MathJax"');
  });

  it('should render display matrix', () => {
    const svg = renderMath('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', true);
    expect(svg).toContain('<svg');
    expect(svg).toContain('display="true"');
  });

  it('should render aligned equations', () => {
    const svg = renderMath('\\begin{aligned} x &= y + 1 \\\\ z &= 2x \\end{aligned}', true);
    expect(svg).toContain('<svg');
  });

  it('should render cases', () => {
    const svg = renderMath('\\begin{cases} 1 & x \\ge 0 \\\\ 0 & x < 0 \\end{cases}', true);
    expect(svg).toContain('<svg');
  });

  it('should not crash on invalid syntax', () => {
    const svg = renderMath('\\invalidSyntax{123}', false);
    expect(svg).toBeDefined();
    // It should either render via noerrors or catch
    expect(typeof svg).toBe('string');
  });
});
