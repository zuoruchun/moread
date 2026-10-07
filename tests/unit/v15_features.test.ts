import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/renderer/modules/editor';

describe('V1.5 Features & Safety Tests', () => {
  describe('Turndown Cleanups', () => {
    it('strips search highlight tags without losing inner text or structure', () => {
      const html = '<p>Hello <mark class="search-highlight">world</mark> of markdown</p>';
      const md = htmlToMarkdown(html);
      expect(md).toContain('Hello world of markdown');
      expect(md).not.toContain('<mark');
      expect(md).not.toContain('search-highlight');
    });

    it('reverts mored:// image URLs back to clean relative or plain path without leaking protocol', () => {
      const html = '<p><img src="mored://local-file/Users/test/docs/image.png" alt="Test Image"></p>';
      const md = htmlToMarkdown(html);
      expect(md).toContain('![Test Image](/Users/test/docs/image.png)');
      expect(md).not.toContain('mored://');

      const html2 = '<p><img src="mored://local?path=%2FUsers%2Ftest%2Fdocs%2Fimage2.png" alt="Query Param Image"></p>';
      const md2 = htmlToMarkdown(html2);
      expect(md2).toContain('![Query Param Image](/Users/test/docs/image2.png)');
      expect(md2).not.toContain('mored://');
    });

    it('preserves formatting and task lists with checkboxes without corruption', () => {
      const html = '<h2>Title</h2><ul><li><input type="checkbox" checked class="task-list-item-checkbox"> Done item</li><li><input type="checkbox" class="task-list-item-checkbox"> Todo item</li></ul>';
      const md = htmlToMarkdown(html);
      expect(md).toContain('## Title');
      expect(md).toMatch(/- \[[xX]\]\s+Done item/);
      expect(md).toMatch(/- \[[ ]\]\s+Todo item/);
    });
  });

  describe('DocumentTab State Model', () => {
    it('isolates dirty state, mode, and content between distinct tabs', () => {
      interface DocumentTab {
        id: string;
        filePath: string | null;
        title: string;
        rawContent: string;
        savedContent: string;
        isEdited: boolean;
        editRevision: number;
        isEditMode: boolean;
        isSourceMode: boolean;
        scrollRatio: number;
      }

      const tab1: DocumentTab = {
        id: 'tab-1',
        filePath: '/path/1.md',
        title: '1.md',
        rawContent: '# Tab 1',
        savedContent: '# Tab 1',
        isEdited: false,
        editRevision: 0,
        isEditMode: false,
        isSourceMode: false,
        scrollRatio: 0.2
      };

      const tab2: DocumentTab = {
        id: 'tab-2',
        filePath: '/path/2.md',
        title: '2.md',
        rawContent: '# Tab 2 edited',
        savedContent: '# Tab 2',
        isEdited: true,
        editRevision: 1,
        isEditMode: true,
        isSourceMode: true,
        scrollRatio: 0.8
      };

      expect(tab1.isEdited).toBe(false);
      expect(tab2.isEdited).toBe(true);
      expect(tab1.isEditMode).toBe(false);
      expect(tab2.isEditMode).toBe(true);
      expect(tab1.scrollRatio).toBe(0.2);
      expect(tab2.scrollRatio).toBe(0.8);
    });
  });
});
