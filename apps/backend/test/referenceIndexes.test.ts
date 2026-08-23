import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships without
// docs/reference, so these assertions run only where the indexes are.
const referenceIndexesPresent = existsSync(
  join(process.cwd(), "..", "..", "docs/reference/apple-wwdc2023-spatial-video-manifest.json")
);

interface VideoReferenceManifest {
  source: {
    id: string;
    title: string;
    url: string;
  };
  videos: Array<{
    id: string;
    title: string;
    url: string;
    indexPath: string;
    relatedTo?: string;
  }>;
}

interface VideoReferenceIndex {
  source: {
    id: string;
    title: string;
    url: string;
    retrievedAt: string;
    transcriptLocator: string;
    notes: string;
  };
  entries: Array<{
    id: string;
    startSeconds: number;
    endSeconds: number;
    url: string;
    chapter: string;
    topics: string[];
    visualCue: string;
    transcriptUse: string;
  }>;
}

const readJson = async <T>(relativePath: string): Promise<T> => {
  const raw = await readFile(join(process.cwd(), "..", "..", relativePath), "utf8");
  return JSON.parse(raw) as T;
};

const expectEntryToBeParaphrased = (entry: VideoReferenceIndex["entries"][number]) => {
  const entryRecord = entry as unknown as Record<string, unknown>;

  expect(entryRecord.transcript).toBeUndefined();
  expect(entryRecord.transcriptText).toBeUndefined();
  expect(entryRecord.caption).toBeUndefined();
  expect(entryRecord.captions).toBeUndefined();
  expect(entry.visualCue).not.toContain("\n");
  expect(entry.transcriptUse).not.toContain("\n");
  expect(entry.visualCue.length).toBeLessThanOrEqual(260);
  expect(entry.transcriptUse.length).toBeLessThanOrEqual(180);
};

describe.skipIf(!referenceIndexesPresent)("reference indexes", () => {
  it("keeps the WWDC spatial UI index timestamp-addressable without storing the full transcript", async () => {
    const index = await readJson<VideoReferenceIndex>(
      "docs/reference/apple-wwdc2023-10076-spatial-ui-index.json"
    );

    expect(index.source).toMatchObject({
      id: "apple-wwdc2023-10076",
      url: "https://developer.apple.com/videos/play/wwdc2023/10076/"
    });
    expect(index.entries.length).toBeGreaterThan(20);
    expect(index.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "materials-glass-window",
          startSeconds: 197,
          topics: expect.arrayContaining(["glass material"])
        }),
        expect.objectContaining({
          id: "layout-target-size",
          startSeconds: 636,
          topics: expect.arrayContaining(["tap target"])
        }),
        expect.objectContaining({
          id: "components-ornaments",
          startSeconds: 1047,
          topics: expect.arrayContaining(["ornaments"])
        })
      ])
    );

    for (const entry of index.entries) {
      expect(entry.endSeconds).toBeGreaterThan(entry.startSeconds);
      expect(entry.url).toBe(`${index.source.url}?time=${entry.startSeconds}`);
      expect(entry.visualCue.length).toBeGreaterThan(10);
      expectEntryToBeParaphrased(entry);
    }
  });

  it("indexes the WWDC 2023 spatial design reference video collection", async () => {
    const manifest = await readJson<VideoReferenceManifest>(
      "docs/reference/apple-wwdc2023-spatial-video-manifest.json"
    );

    expect(manifest.source).toMatchObject({
      id: "apple-wwdc2023-spatial-video-collection",
      url: "https://developer.apple.com/videos/play/wwdc2023/10076/?time=0"
    });
    expect(manifest.videos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "apple-wwdc2023-10076" }),
        expect.objectContaining({ id: "apple-wwdc2023-10078" }),
        expect.objectContaining({ id: "apple-wwdc2023-10073" }),
        expect.objectContaining({ id: "apple-wwdc2023-10075" }),
        expect.objectContaining({ id: "apple-wwdc2023-10271" }),
        expect.objectContaining({ id: "apple-wwdc2023-10109" }),
        expect.objectContaining({ id: "apple-wwdc2023-10072" })
      ])
    );

    for (const video of manifest.videos) {
      expect(video.indexPath).toMatch(/^docs\/reference\/apple-wwdc2023-\d+-[\w-]+-index\.json$/);

      const index = await readJson<VideoReferenceIndex>(video.indexPath);
      expect(index.source).toMatchObject({
        id: video.id,
        title: video.title,
        url: video.url,
        transcriptLocator: "#transcript-content span[data-start]"
      });
      expect(index.source.notes).toContain("does not store the full transcript");
      expect(index.entries.length).toBeGreaterThanOrEqual(8);

      for (const entry of index.entries) {
        expect(entry.id.length).toBeGreaterThan(4);
        expect(entry.endSeconds).toBeGreaterThan(entry.startSeconds);
        expect(entry.url).toBe(`${index.source.url}?time=${entry.startSeconds}`);
        expect(entry.chapter.length).toBeGreaterThan(2);
        expect(entry.topics.length).toBeGreaterThan(0);
        expect(entry.visualCue.length).toBeGreaterThan(10);
        expectEntryToBeParaphrased(entry);
      }
    }
  });
});
