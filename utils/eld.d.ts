declare module "eld/core" {
  interface EldResult {
    language: string;
    getScores(): Record<string, number>;
    isReliable(thresholdRatio?: number): boolean;
  }
  interface EldInstance {
    detect(text: string): EldResult;
    enableTextCleanup(enabled: boolean): void;
  }
  export function createEld(): { instance: EldInstance; loadData(data: unknown): string };
}
