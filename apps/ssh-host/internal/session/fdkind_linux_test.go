//go:build linux

package session

import "syscall"

// Filesystem magic numbers from linux/magic.h.
const (
	cgroup2SuperMagic = 0x63677270
	cgroupSuperMagic  = 0x27e0eb
)

// onCgroupFilesystem reports whether a descriptor refers to a file on a cgroup
// filesystem (v1 or v2). Those files are kernel pseudo-files: nothing can write
// a credential or a key into one, so a descriptor there is never the leak the
// isolation assertion is looking for.
//
// It exists because the Go runtime (1.25 and later, container-aware
// GOMAXPROCS) opens its own cgroup's cpu.max at startup and keeps it open to
// re-read the CPU limit. Any Go child that runs inside a CPU-limited cgroup
// therefore holds a "regular" descriptor that the host never gave it — CI hit
// exactly this (fd 5 -> /sys/fs/cgroup/user/cpu.max) once the runner began
// placing jobs in a non-root cgroup.
func onCgroupFilesystem(fd int) bool {
	var fs syscall.Statfs_t
	if err := syscall.Fstatfs(fd, &fs); err != nil {
		return false
	}
	return fs.Type == cgroup2SuperMagic || fs.Type == cgroupSuperMagic
}
