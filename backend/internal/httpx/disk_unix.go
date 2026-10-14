//go:build !windows

package httpx

import "golang.org/x/sys/unix"

func getDiskSpace(path string) (total, free, used uint64) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, 0, 0
	}
	total = stat.Blocks * uint64(stat.Bsize)
	free = stat.Bavail * uint64(stat.Bsize)
	if total >= free {
		used = total - free
	}
	return total, free, used
}
