// Global type declarations for svg-bbox project

// Puppeteer page.evaluate context - window.SvgVisualBBox
declare global {
  interface Window {
    SvgVisualBBox?: {
      waitForDocumentFonts: (doc?: Document, timeoutMs?: number) => Promise<void>;
      getSvgElementVisualBBoxTwoPassAggressive: (
        target: string | Element,
        options?: any
      ) => Promise<any>;
      getSvgElementsUnionVisualBBox: (targets: (string | Element)[], options?: any) => Promise<any>;
      getSvgElementVisibleAndFullBBoxes: (target: string | Element, options?: any) => Promise<any>;
      showTrueBBoxBorder: (target: string | Element, options?: any) => Promise<any>;
      setViewBoxOnObjects: (
        target: string | Element,
        objectIds: string | string[],
        options?: any
      ) => Promise<any>;
      listSvgObjects: (target: string | Element, options?: any) => Promise<any>;
      exportSvgObjects: (
        target: string | Element,
        objectIds: string | string[],
        options?: any
      ) => Promise<any>;
    };
  }

  // UMD pattern - define
  function define(factory: () => any): void;
  namespace define {
    let amd: any | undefined;
  }

  // Chrome launcher options
  interface LaunchOptions {
    headless?: boolean | 'shell' | 'new';
    [key: string]: any;
  }
}

// SVG DOM extensions
interface Element {
  getBBox?: () => DOMRect;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface HTMLElement {
  getBBox?: () => DOMRect;
}

interface SVGSVGElement {
  getBBox(): DOMRect;
}

// ParentNode extensions
interface ParentNode {
  getAttribute?(name: string): string | null;
}

// Node extensions
interface Node {
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  tagName?: string;
}

// ChildNode extensions
interface ChildNode {
  tagName?: string;
}

// Allow unknown types to be treated as errors
interface Unknown {
  stack?: string;
  message?: string;
}

export {};
