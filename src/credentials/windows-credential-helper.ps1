$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class CodexCredentialManager {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr buffer);

    public static int Write(string target, string userName, byte[] secret) {
        IntPtr blob = IntPtr.Zero;
        try {
            blob = Marshal.AllocHGlobal(secret.Length);
            if (secret.Length > 0) Marshal.Copy(secret, 0, blob, secret.Length);
            var credential = new CREDENTIAL {
                Type = 1,
                TargetName = target,
                CredentialBlobSize = (UInt32)secret.Length,
                CredentialBlob = blob,
                Persist = 2,
                UserName = userName
            };
            return CredWrite(ref credential, 0) ? 0 : Marshal.GetLastWin32Error();
        } finally {
            if (blob != IntPtr.Zero) {
                for (int i = 0; i < secret.Length; i++) Marshal.WriteByte(blob, i, 0);
                Marshal.FreeHGlobal(blob);
            }
        }
    }

    public static byte[] Read(string target, out int error) {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) {
            error = Marshal.GetLastWin32Error();
            return null;
        }
        try {
            var credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
            var result = new byte[credential.CredentialBlobSize];
            if (result.Length > 0) Marshal.Copy(credential.CredentialBlob, result, 0, result.Length);
            error = 0;
            return result;
        } finally {
            CredFree(pointer);
        }
    }

    public static int Delete(string target) {
        return CredDelete(target, 1, 0) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@

$failureCode = 71
try {
    Add-Type -TypeDefinition $source -Language CSharp
    $failureCode = 72
    $pipeName = $env:CODEX_CREDENTIAL_PIPE
    if ([string]::IsNullOrWhiteSpace($pipeName)) { exit 70 }
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::None,
        [System.Security.Principal.TokenImpersonationLevel]::Identification)
    $failureCode = 73
    $pipe.Connect(10000)
    $failureCode = 74
    $reader = [System.IO.StreamReader]::new($pipe, [System.Text.Encoding]::UTF8, $false, 4096, $true)
    $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 4096, $true)
    $writer.AutoFlush = $true
    if ([string]::IsNullOrWhiteSpace($env:CODEX_CREDENTIAL_NONCE)) { exit 70 }
    $writer.WriteLine($env:CODEX_CREDENTIAL_NONCE)
    $failureCode = 75
    $request = $reader.ReadLine() | ConvertFrom-Json
    $failureCode = 76
    $response = @{ status = 'ERROR'; code = 'NATIVE_FAILURE' }
    if ($request.operation -eq 'write') {
        $bytes = [Convert]::FromBase64String([string]$request.secret)
        try {
            $code = [CodexCredentialManager]::Write($request.target, $request.username, $bytes)
        } finally {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        }
        if ($code -eq 0) {
            $response = @{ status = 'OK' }
        } else {
            $response = @{ status = 'ERROR'; nativeCode = $code }
        }
    } elseif ($request.operation -eq 'read') {
        $code = 0
        $bytes = [CodexCredentialManager]::Read($request.target, [ref]$code)
        try {
            if ($code -eq 0) {
                $response = @{ status = 'OK'; secret = [Convert]::ToBase64String($bytes) }
            } else {
                $response = @{ status = 'ERROR'; nativeCode = $code }
            }
        } finally {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        }
    } elseif ($request.operation -eq 'delete') {
        $code = [CodexCredentialManager]::Delete($request.target)
        if ($code -eq 0) {
            $response = @{ status = 'OK' }
        } else {
            $response = @{ status = 'ERROR'; nativeCode = $code }
        }
    } else {
        $response = @{ status = 'ERROR'; code = 'INVALID_OPERATION' }
    }
    $writer.WriteLine(($response | ConvertTo-Json -Compress))
    $failureCode = 77
    $writer.Dispose()
    $reader.Dispose()
    $pipe.Dispose()
} catch {
    exit $failureCode
}
