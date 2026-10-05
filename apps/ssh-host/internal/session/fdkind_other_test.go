//go:build !linux

package session

// onCgroupFilesystem is Linux-only (cgroups do not exist elsewhere), so on
// other systems every regular file stays "regular" and fails the assertion.
func onCgroupFilesystem(int) bool { return false }
