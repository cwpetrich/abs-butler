import { describe, expect, it } from 'vitest';
import { describeMount, libraryMounts, mountFor, parseMountInfo } from './mounts.js';

// Trimmed from a real abs-butler container, plus a cifs share and a path with a
// space in it, which mountinfo writes as \040.
const MOUNTINFO = `\
612 489 0:62 / / rw,relatime master:218 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/X
613 612 0:65 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
614 612 0:66 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
618 612 0:63 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
622 612 254:1 /docker/volumes/abs-butler_butler-data/_data /data rw,relatime - ext4 /dev/vda1 rw
623 612 0:120 / /audiobooks rw,relatime - cifs //192.168.1.50/AudioBooks rw,vers=3.0,uid=1000
624 612 254:1 /home/me/Kids\\040Books /kids rw,relatime - ext4 /dev/vda1 rw
625 612 254:1 /docker/containers/abc/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw
626 612 254:1 /docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw
`;

describe('parseMountInfo', () => {
  it('reads the mount point, filesystem and source past the optional fields', () => {
    const mounts = parseMountInfo(MOUNTINFO);
    expect(mounts.find((m) => m.path === '/audiobooks')).toEqual({
      path: '/audiobooks',
      fsType: 'cifs',
      source: '//192.168.1.50/AudioBooks',
    });
    expect(mounts.find((m) => m.path === '/')?.fsType).toBe('overlay');
  });

  it('ignores lines that are not mount entries', () => {
    expect(parseMountInfo('\n\ngarbage\n')).toEqual([]);
  });
});

describe('libraryMounts', () => {
  it('keeps only what could hold a library', () => {
    const paths = libraryMounts(parseMountInfo(MOUNTINFO), '/data').map((m) => m.path);
    expect(paths).toEqual(['/audiobooks', '/kids']);
  });

  it('keeps removable media under /run while dropping the rest of /run', () => {
    const mounts = parseMountInfo(
      '1 0 0:1 / /run/lock rw - tmpfs tmpfs rw\n2 0 8:1 / /run/media/me/Books rw - ext4 /dev/sdb1 rw\n',
    );
    expect(libraryMounts(mounts, '/data').map((m) => m.path)).toEqual(['/run/media/me/Books']);
  });
});

describe('mountFor', () => {
  it('picks the deepest mount containing the path', () => {
    const mounts = parseMountInfo(MOUNTINFO);
    expect(mountFor('/audiobooks/Author/Title', mounts)?.fsType).toBe('cifs');
    expect(mountFor('/audiobooks2', mounts)?.path).toBe('/');
  });
});

describe('describeMount', () => {
  it('names the share for network mounts only', () => {
    const [audiobooks, kids] = libraryMounts(parseMountInfo(MOUNTINFO), '/data');
    expect(describeMount(audiobooks!)).toBe('/audiobooks (cifs //192.168.1.50/AudioBooks)');
    expect(describeMount(kids!)).toBe('/kids');
  });
});
