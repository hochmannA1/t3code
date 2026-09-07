// @effect-diagnostics nodeBuiltinImport:off - ZIP entries use lazy native streams.
import * as NodeStream from "node:stream";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ZipFile } from "yazl";

/** Streams file contents on demand; symlinks and special files are never archived. */
export async function directoryDownload(root: string) {
  const entries: Array<{ source: string; name: string; directory: boolean }> = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const source = NodePath.join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink() || (await NodeFSP.realpath(source)) !== source) continue;
      if (entry.isDirectory()) {
        entries.push({ source, name, directory: true });
        await visit(source, `${name}/`);
      } else if (entry.isFile()) entries.push({ source, name, directory: false });
    }
  }
  await visit(root, `${NodePath.basename(root) || "files"}/`);
  const zip = new ZipFile();
  const output = zip.outputStream;
  if (!(output instanceof NodeStream.Readable)) throw new Error("Invalid ZIP output stream.");
  const activeStreams = new Set<NodeFS.ReadStream>();
  output.on("close", () => {
    for (const stream of activeStreams) stream.destroy();
  });
  zip.on("error", (error: Error) => output.destroy(error));
  try {
    for (const { source, name, directory } of entries) {
      if (directory) zip.addEmptyDirectory(name);
      else {
        zip.addReadStreamLazy(name, {}, (callback) => {
          void (async () => {
            const handle = await NodeFSP.open(
              source,
              NodeFS.constants.O_RDONLY |
                (NodeFS.constants.O_NOFOLLOW ?? 0) |
                (NodeFS.constants.O_NONBLOCK ?? 0),
            );
            try {
              if (!(await handle.stat()).isFile() || (await NodeFSP.realpath(source)) !== source) {
                throw new Error("Download entry changed while creating the archive.");
              }
              const stream = handle.createReadStream();
              activeStreams.add(stream);
              stream.on("close", () => activeStreams.delete(stream));
              if (output.destroyed) stream.destroy();
              callback(null, stream);
            } catch (error) {
              await handle.close();
              throw error;
            }
          })().catch((error: unknown) =>
            callback(
              error instanceof Error ? error : new Error(String(error)),
              NodeStream.Readable.from([]),
            ),
          );
        });
      }
    }
    zip.end();
    return output;
  } catch (error) {
    output.destroy();
    throw error;
  }
}
