using AgentR.Protocol;
using AgentR.Worker.Config;

namespace AgentR.Worker.IO;

public static class ProjectDiskProbe
{
    public static List<ProjectDisk> Probe(IReadOnlyDictionary<string, ProjectEntry> projects)
    {
        var list = new List<ProjectDisk>();
        foreach (var (alias, entry) in projects)
        {
            var path = entry.Path;
            if (string.IsNullOrWhiteSpace(path))
            {
                list.Add(new ProjectDisk { Alias = alias, Path = path, Error = "empty path" });
                continue;
            }
            try
            {
                var root = Path.GetPathRoot(Path.GetFullPath(path));
                if (string.IsNullOrEmpty(root))
                {
                    list.Add(new ProjectDisk { Alias = alias, Path = path, Error = "no root" });
                    continue;
                }
                var di = new DriveInfo(root);
                list.Add(new ProjectDisk
                {
                    Alias = alias,
                    Path = path,
                    FreeBytes = di.AvailableFreeSpace,
                    TotalBytes = di.TotalSize,
                });
            }
            catch (Exception ex)
            {
                list.Add(new ProjectDisk { Alias = alias, Path = path, Error = ex.Message });
            }
        }
        return list;
    }
}
