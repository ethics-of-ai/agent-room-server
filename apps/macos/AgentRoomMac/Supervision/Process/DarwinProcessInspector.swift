import Darwin
import Foundation

struct DarwinProcessInspector: BackendProcessInspecting {
    func describe(pid: pid_t, port: Int) -> BackendProcessIdentity? {
        guard pid > 0, let startTime = Self.startTime(of: pid), let path = Self.executablePath(of: pid) else {
            return nil
        }
        return BackendProcessIdentity(
            pid: pid,
            startTimeSeconds: Int64(startTime.tv_sec),
            startTimeMicroseconds: Int32(startTime.tv_usec),
            executablePath: path,
            port: port
        )
    }

    func ownsListeningTCPPort(_ port: Int, for identity: BackendProcessIdentity) -> Bool {
        guard (1...Int(UInt16.max)).contains(port), isAlive(identity) else {
            return false
        }

        let byteCount = proc_pidinfo(identity.pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard byteCount > 0 else {
            return false
        }
        let descriptorCount = Int(byteCount) / MemoryLayout<proc_fdinfo>.stride
        var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: descriptorCount)
        let filledByteCount = descriptors.withUnsafeMutableBytes { buffer in
            proc_pidinfo(identity.pid, PROC_PIDLISTFDS, 0, buffer.baseAddress, Int32(buffer.count))
        }
        guard filledByteCount > 0 else {
            return false
        }

        let filledDescriptorCount = min(
            Int(filledByteCount) / MemoryLayout<proc_fdinfo>.stride,
            descriptors.count
        )
        for descriptor in descriptors.prefix(filledDescriptorCount)
        where descriptor.proc_fdtype == PROX_FDTYPE_SOCKET {
            var socketInfo = socket_fdinfo()
            let socketByteCount = withUnsafeMutablePointer(to: &socketInfo) { pointer in
                proc_pidfdinfo(
                    identity.pid,
                    descriptor.proc_fd,
                    PROC_PIDFDSOCKETINFO,
                    pointer,
                    Int32(MemoryLayout<socket_fdinfo>.stride)
                )
            }
            guard socketByteCount == MemoryLayout<socket_fdinfo>.stride,
                  socketInfo.psi.soi_kind == SOCKINFO_TCP,
                  socketInfo.psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN else {
                continue
            }
            let networkPort = UInt16(truncatingIfNeeded: socketInfo.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport)
            if Int(UInt16(bigEndian: networkPort)) == port {
                return true
            }
        }
        return false
    }

    @discardableResult
    func signal(_ signal: Int32, to identity: BackendProcessIdentity) -> Bool {
        guard isAlive(identity) else {
            return false
        }
        return kill(identity.pid, signal) == 0
    }

    private static func startTime(of pid: pid_t) -> timeval? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else {
            return nil
        }
        let startTime = info.kp_proc.p_starttime
        guard startTime.tv_sec != 0 || startTime.tv_usec != 0 else {
            return nil
        }
        return startTime
    }

    private static func executablePath(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else {
            return nil
        }
        return String(cString: buffer)
    }
}
