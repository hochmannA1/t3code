// @effect-diagnostics nodeBuiltinImport:off - exercises the native ZIP stream.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fromBuffer, type Entry } from "yauzl";
import { describe, expect, it } from "vite-plus/test";
import { directoryDownload } from "./DirectoryDownload.ts";

function readZip(buffer: Buffer): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries: Record<string, Buffer> = {};
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry: Entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

describe("directory downloads", () => {
  it("creates a readable ZIP with binary files, Unicode names, and empty folders, excluding symlinks", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-download-")),
    );
    try {
      await NodeFSP.mkdir(NodePath.join(root, "empty"));
      await NodeFSP.mkdir(NodePath.join(root, "nested"));
      const bytes = Buffer.from([0, 255, 128, 13, 10]);
      await NodeFSP.writeFile(NodePath.join(root, "nested", "réport.bin"), bytes);
      await NodeFSP.symlink(NodeOS.tmpdir(), NodePath.join(root, "outside")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPERM") throw error;
        },
      );
      const stream = await directoryDownload(root);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const entries = await readZip(Buffer.concat(chunks));
      const prefix = NodePath.basename(root);
      expect(Object.keys(entries).sort()).toEqual([
        `${prefix}/empty/`,
        `${prefix}/nested/`,
        `${prefix}/nested/réport.bin`,
      ]);
      expect(entries[`${prefix}/nested/réport.bin`]).toEqual(bytes);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
