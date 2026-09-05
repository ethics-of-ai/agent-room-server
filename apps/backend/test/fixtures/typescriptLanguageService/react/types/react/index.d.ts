export interface ReactElement {
  readonly type: string;
  readonly props: Record<string, unknown>;
}

export declare function useState<T>(initial: T): readonly [T, (next: T) => void];

declare global {
  namespace JSX {
    interface Element extends ReactElement {}

    interface IntrinsicElements {
      button: {
        "aria-label"?: string;
        children?: unknown;
      };
    }
  }
}
