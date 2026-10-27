// xmldom's own types pull the browser DOM library into the whole API. The SAML code imports the
// parser by file instead, typed with just the parts it reads.
declare module '@xmldom/xmldom/lib/dom-parser.js' {
  export interface XmlElement {
    localName: string | null;
    namespaceURI: string | null;
    textContent: string | null;
    childNodes: ArrayLike<XmlElement>;
    getAttribute(name: string): string | null;
    getElementsByTagNameNS(namespace: string, name: string): ArrayLike<XmlElement>;
  }
  export interface XmlDocument {
    documentElement: XmlElement | null;
    getElementsByTagNameNS(namespace: string, name: string): ArrayLike<XmlElement>;
  }
  export class DOMParser {
    constructor(options?: {
      errorHandler?: {
        warning?: (msg: string) => void;
        error?: (msg: string) => void;
        fatalError?: (msg: string) => void;
      };
    });
    parseFromString(source: string, mimeType: string): XmlDocument;
  }
}
