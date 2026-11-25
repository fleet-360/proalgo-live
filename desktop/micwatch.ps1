# Prints, every 2 seconds, the processes that hold an active microphone (capture) audio session:
#   MIC|zoom,chrome
# Reads the Windows audio session manager directly, so it works on Windows builds where the
# CapabilityAccessManager registry entries are no longer updated.
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ProAlgo {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr a, IntPtr b);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr a, IntPtr b);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(IntPtr a, IntPtr b);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr a);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr a);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
  }

  public static class MicWatch {
    public static string ActiveCaptureApps() {
      var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
      IMMDeviceCollection devs;
      if (en.EnumAudioEndpoints(1 /* eCapture */, 1 /* ACTIVE */, out devs) != 0) return "";
      uint n; devs.GetCount(out n);
      Guid iid = typeof(IAudioSessionManager2).GUID;
      for (uint i = 0; i < n; i++) {
        try {
          IMMDevice dev; if (devs.Item(i, out dev) != 0) continue;
          object o; if (dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) continue;
          IAudioSessionEnumerator se; if (((IAudioSessionManager2)o).GetSessionEnumerator(out se) != 0) continue;
          int c; se.GetCount(out c);
          for (int j = 0; j < c; j++) {
            try {
              IAudioSessionControl2 s; if (se.GetSession(j, out s) != 0) continue;
              int state; s.GetState(out state);
              if (state != 1 /* AudioSessionStateActive */) continue;
              uint pid; s.GetProcessId(out pid);
              if (pid == 0) continue;
              try { names.Add(Process.GetProcessById((int)pid).ProcessName); } catch { }
            } catch { }
          }
        } catch { }
      }
      return string.Join(",", names);
    }
  }
}
"@

while ($true) {
  try { $apps = [ProAlgo.MicWatch]::ActiveCaptureApps() } catch { $apps = "" }
  [Console]::Out.WriteLine("MIC|" + $apps)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
