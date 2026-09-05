/**
 * Recognizes the allocator's legacy date/slug layout; stored projects have no
 * explicit origin field. Renaming a thread does not affect this project title.
 * Renaming the project or relocating its folder loses this classification, and
 * a manually selected folder with the same layout is indistinguishable.
 */
export function isStandaloneProject(project: {
  readonly title: string;
  readonly workspaceRoot: string;
}): boolean {
  const segments = project.workspaceRoot.split(/[\\/]+/u).filter(Boolean);
  const directoryName = segments.at(-1);
  const dateDirectory = segments.at(-2);
  return (
    directoryName === project.title &&
    directoryName.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(directoryName) &&
    dateDirectory !== undefined &&
    /^\d{4}-\d{2}-\d{2}$/u.test(dateDirectory)
  );
}
