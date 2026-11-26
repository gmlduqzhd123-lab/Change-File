// 툭 — 파일을 툭 놓으면 PDF·용량 줄이기·압축을 해 주는 작은 윈도우 프로그램.
// .NET Framework 4.x 기본 컴파일러(C# 5)로 빌드한다. build.ps1 참고.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Wic = System.Windows.Media.Imaging;
using WinPdf = Windows.Data.Pdf;
using WinAsync = Windows.Foundation;
using WinStreams = Windows.Storage.Streams;

namespace Tuk
{
    static class AppInfo
    {
        public const string Name = "툭";
        public const string Version = "1.2.0";
        public static string InstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Tuk"); }
        }
        public static string InstalledExe { get { return Path.Combine(InstallDir, "Tuk.exe"); } }
        public static string SendToLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.SendTo), Name + ".lnk"); } }
        public static string StartLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk"); } }
    }

    // ───────────── 새 버전 (GitHub Pages의 version.json) ─────────────
    // version.json: {"version":"0.2.0","url":"https://gmlduqzhd123-lab.github.io/Change-File/download/Tuk.exe","sha256":"64자","notes":"고친 점"}
    // 주소는 이 사이트 안만 받고, 받은 파일은 SHA-256이 맞을 때만 쓴다. 문서나 PC 정보는 보내지 않는다.
    static class Updater
    {
        public const string Site = "https://gmlduqzhd123-lab.github.io/Change-File/";

        public sealed class Info { public string Version, Url, Sha256, Notes; }

        /// 시험 때만 이 PC 안의 가짜 서버(http://127.0.0.1:포트/)를 쓴다.
        static string Base
        {
            get
            {
                string t = Environment.GetEnvironmentVariable("TUK_UPDATE_BASE");
                if (!string.IsNullOrEmpty(t) && t.StartsWith("http://127.0.0.1:", StringComparison.Ordinal)) return t.TrimEnd('/') + "/";
                return Site;
            }
        }

        static string StateFile
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tuk", "last-update-check.txt"); }
        }

        static string Today { get { return DateTime.Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); } }

        public static bool CheckedToday
        {
            get { try { return File.Exists(StateFile) && File.ReadAllText(StateFile).Trim() == Today; } catch { return false; } }
        }

        static void MarkChecked()
        {
            try { Directory.CreateDirectory(Path.GetDirectoryName(StateFile)); File.WriteAllText(StateFile, Today); } catch { }
        }

        static int[] Parts(string v)
        {
            if (v == null || !System.Text.RegularExpressions.Regex.IsMatch(v, @"^\d{1,5}(\.\d{1,5}){0,3}$")) return null;
            return v.Split('.').Select(x => int.Parse(x, CultureInfo.InvariantCulture)).ToArray();
        }

        public static bool IsNewer(string candidate, string current)
        {
            int[] a = Parts(candidate), b = Parts(current);
            if (a == null || b == null) return false;
            for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
            {
                int x = i < a.Length ? a[i] : 0, y = i < b.Length ? b[i] : 0;
                if (x != y) return x > y;
            }
            return false;
        }

        static string Field(string json, string name)
        {
            var m = System.Text.RegularExpressions.Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? System.Text.RegularExpressions.Regex.Unescape(m.Groups[1].Value) : null;
        }

        static HttpWebResponseHolder Get(string url, int timeoutMs)
        {
            System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12;
            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.UserAgent = "Tuk/" + AppInfo.Version;
            req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            return new HttpWebResponseHolder((System.Net.HttpWebResponse)req.GetResponse());
        }

        sealed class HttpWebResponseHolder : IDisposable
        {
            public readonly System.Net.HttpWebResponse R;
            public HttpWebResponseHolder(System.Net.HttpWebResponse r) { R = r; }
            public void Dispose() { R.Close(); }
        }

        /// 새 버전이 있으면 정보를, 최신이면 null. 연결이 안 되면 예외.
        public static Info Check()
        {
            string json;
            using (var h = Get(Base + "version.json", 10000))
            using (var rd = new StreamReader(h.R.GetResponseStream(), Encoding.UTF8)) json = rd.ReadToEnd();
            MarkChecked();
            var i = new Info { Version = Field(json, "version"), Url = Field(json, "url"), Sha256 = (Field(json, "sha256") ?? "").ToLowerInvariant(), Notes = Field(json, "notes") ?? "" };
            Uri u;
            bool urlOk = i.Url != null && Uri.TryCreate(i.Url, UriKind.Absolute, out u) && u.AbsoluteUri.StartsWith(Base, StringComparison.Ordinal);
            if (Parts(i.Version) == null || !urlOk || !System.Text.RegularExpressions.Regex.IsMatch(i.Sha256, "^[0-9a-f]{64}$"))
                throw new Exception("새 버전 정보가 올바르지 않아요.");
            return IsNewer(i.Version, AppInfo.Version) ? i : null;
        }

        /// 받아서 확인한 뒤 지금 실행 파일과 바꾼다. 실행 중인 파일은 지울 수 없지만 이름은 바꿀 수 있어서,
        /// 지금 것을 Tuk.old.exe로 옮기고 새 것을 그 자리에 둔다. 돌려주는 값은 새 실행 파일 경로.
        public static string Apply(Info i, Action<double> progress)
        {
            string exe = Application.ExecutablePath;
            string dir = Path.GetDirectoryName(exe);
            string part = Path.Combine(dir, "Tuk.new.exe");
            string old = Path.Combine(dir, "Tuk.old.exe");
            try
            {
                using (var h = Get(i.Url, 60000))
                using (var src = h.R.GetResponseStream())
                using (var dst = new FileStream(part, FileMode.Create, FileAccess.Write))
                {
                    long total = h.R.ContentLength, got = 0;
                    if (total > 50L * 1024 * 1024) throw new Exception("받을 파일이 너무 커요.");
                    var buf = new byte[81920];
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        dst.Write(buf, 0, n);
                        got += n;
                        if (got > 50L * 1024 * 1024) throw new Exception("받을 파일이 너무 커요.");
                        if (progress != null && total > 0) progress((double)got / total);
                    }
                }
                string sha;
                using (var s = System.Security.Cryptography.SHA256.Create())
                using (var f = File.OpenRead(part)) sha = string.Concat(s.ComputeHash(f).Select(b => b.ToString("x2")));
                if (sha != i.Sha256) throw new Exception("받은 파일이 올바르지 않아서 쓰지 않았어요.");

                if (File.Exists(old)) File.Delete(old);
                File.Move(exe, old);
                try { File.Move(part, exe); }
                catch { File.Move(old, exe); throw; }
                return exe;
            }
            finally
            {
                try { if (File.Exists(part)) File.Delete(part); } catch { }
            }
        }

        /// 바꾸고 난 뒤 남은 옛 실행 파일을 지운다(이미 끝난 뒤라 지울 수 있다).
        public static void CleanupOld()
        {
            try
            {
                string old = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "Tuk.old.exe");
                if (File.Exists(old)) File.Delete(old);
            }
            catch { }
        }
    }

    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Ui.UseSharpText();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Updater.CleanupOld();

            // 시험용: 창 없이 새 버전 확인(/update-check, 있으면 종료 코드 10) · 바꾸기(/update-apply)
            if (args.Length == 1 && (args[0] == "/update-check" || args[0] == "/update-apply"))
            {
                try
                {
                    var info = Updater.Check();
                    if (info == null) return 0;
                    Console.Error.WriteLine(info.Version);
                    if (args[0] == "/update-apply") Updater.Apply(info, null);
                    return 10;
                }
                catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
            }

            // 시험용: Tuk.exe /run <동작> 파일... (창 없이 실행, 문제 개수를 종료 코드로)
            if (args.Length >= 2 && args[0] == "/run")
            {
                var job = Jobs.Run(args[1], args.Skip(2).ToList());
                foreach (var n in job.Notes) Console.Out.WriteLine(n);
                foreach (var p in job.Problems) Console.Error.WriteLine(p);
                return job.Problems.Count;
            }

            // 시험용: 메뉴 없이 바로 실행하고 알림 창까지 보여 준다
            if (args.Length >= 2 && args[0] == "/run-ui")
            {
                var host = new Form { Opacity = 0, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Size = new Size(1, 1) };
                host.Shown += delegate { Ui.RunWithToast(args[1], args.Skip(2).ToList(), delegate { host.Close(); }); };
                Application.Run(host);
                return 0;
            }

            var files = args.Where(a => File.Exists(a) || Directory.Exists(a)).ToList();
            if (files.Count > 0)
            {
                // 보내기 메뉴로 왔을 때: 커서 옆에 메뉴를 띄운다
                Application.Run(new MenuHost(files));
                return 0;
            }
            Application.Run(new DropWindow());
            return 0;
        }
    }

    // ───────────── 무엇을 할 수 있는지 ─────────────
    static class Kinds
    {
        static readonly string[] Images = { ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif" };
        static readonly string[] Word = { ".doc", ".docx", ".rtf", ".odt", ".txt" };
        static readonly string[] Excel = { ".xls", ".xlsx", ".csv" };
        static readonly string[] Ppt = { ".ppt", ".pptx" };
        static readonly string[] Hwp = { ".hwp", ".hwpx" };

        static string Ext(string f) { return Path.GetExtension(f).ToLowerInvariant(); }
        public static bool IsImage(string f) { return File.Exists(f) && Images.Contains(Ext(f)); }
        public static bool IsWord(string f) { return File.Exists(f) && Word.Contains(Ext(f)); }
        public static bool IsExcel(string f) { return File.Exists(f) && Excel.Contains(Ext(f)); }
        public static bool IsPpt(string f) { return File.Exists(f) && Ppt.Contains(Ext(f)); }
        public static bool IsHwp(string f) { return File.Exists(f) && Hwp.Contains(Ext(f)); }
        public static bool IsZip(string f) { return File.Exists(f) && Ext(f) == ".zip"; }
        public static bool IsPdfFile(string f) { return File.Exists(f) && Ext(f) == ".pdf"; }
        public static bool IsHeic(string f) { return Ext(f) == ".heic" || Ext(f) == ".heif"; }
        public static bool IsJpg(string f) { return Ext(f) == ".jpg" || Ext(f) == ".jpeg"; }
        public static bool ToPdf(string f) { return IsImage(f) || IsWord(f) || IsExcel(f) || IsPpt(f) || IsHwp(f); }
    }

    sealed class MenuChoice
    {
        public string Id, Label, Hint;
        public MenuChoice(string id, string label, string hint) { Id = id; Label = label; Hint = hint; }
    }

    static class Choices
    {
        public static List<MenuChoice> For(IList<string> files)
        {
            var list = new List<MenuChoice>();
            int pdf = files.Count(Kinds.ToPdf);
            int img = files.Count(Kinds.IsImage);
            if (pdf > 0) list.Add(new MenuChoice("pdf", "PDF로", pdf + "개 파일을 각각 PDF로"));
            if (img > 1) list.Add(new MenuChoice("pdfall", "PDF 하나로 묶기", "그림 " + img + "장을 PDF 한 개로"));
            int heic = files.Count(f => Kinds.IsImage(f) && Kinds.IsHeic(f));
            int notJpg = files.Count(f => Kinds.IsImage(f) && !Kinds.IsJpg(f));
            if (notJpg > 0) list.Add(new MenuChoice("tojpg", heic == notJpg ? "JPG로 바꾸기 (아이폰 사진)" : "JPG로 바꾸기",
                (heic == notJpg ? "HEIC " + notJpg + "장을" : "그림 " + notJpg + "장을") + " 어디서나 열리는 JPG로 · 크기 그대로"));
            if (img > 0) list.Add(new MenuChoice("shrink", "그림 용량 줄이기", "크기를 골라요 · JPG"));
            if (img > 0) list.Add(new MenuChoice("rotate", "그림 돌리기", "돌린 그림을 새 파일로 · 원본은 그대로"));
            int pdfs = files.Count(Kinds.IsPdfFile);
            if (pdfs > 0) list.Add(new MenuChoice("pdfjpg", "PDF → JPG 그림", "쪽마다 JPG 한 장 · 여러 쪽이면 새 폴더에"));
            if (pdfs > 0) list.Add(new MenuChoice("pdfweb", "PDF 합치기·쪽 고르기 (웹)", "쪽 번호·워터마크·스캔본 줄이기도 웹 버전에서 해요. 파일을 거기에 놓으면 돼요."));
            list.Add(new MenuChoice("zip", "ZIP으로 묶기", "고른 것을 압축 파일 하나로"));
            if (files.All(Kinds.IsZip)) list.Add(new MenuChoice("unzip", "압축 풀기", "새 폴더에 풀기"));
            return list;
        }
    }

    // ───────────── 일하기 ─────────────
    sealed class JobResult
    {
        public readonly List<string> Made = new List<string>();
        public readonly List<string> Problems = new List<string>();
        public readonly List<string> Notes = new List<string>();
        public bool Cancelled;
    }

    static class Jobs
    {
        public static JobResult Run(string id, IList<string> files)
        {
            return Run(id, files, null, null);
        }

        /// progress(지금 몇 번째, 모두 몇 개, 파일 이름) · stop()이 true면 다음 파일부터 멈춘다
        public static JobResult Run(string id, IList<string> files, Action<int, int, string> progress, Func<bool> stop)
        {
            var r = new JobResult();
            // 파일마다 하는 일: 진행 상황을 알리고, 취소하면 남은 파일은 건너뛴다
            Action<IEnumerable<string>, Action<string>> each = delegate (IEnumerable<string> list, Action<string> work)
            {
                var all = list.ToList();
                for (int i = 0; i < all.Count; i++)
                {
                    if (stop != null && stop())
                    {
                        r.Notes.Insert(0, "취소했어요. " + (all.Count - i) + "개는 하지 않았어요.");
                        r.Cancelled = true;
                        return;
                    }
                    if (progress != null) progress(i + 1, all.Count, Path.GetFileName(all[i]));
                    var f = all[i];
                    Safe(r, f, delegate { work(f); });
                }
            };
            try
            {
                switch (id)
                {
                    case "pdf":
                    case "pdf-n":
                    case "pdf-0":
                        each(files, delegate (string f) { ToPdf(r, f, MarginOf(id)); }); break;
                    case "pdfall":
                    case "pdfall-n":
                    case "pdfall-0":
                    case "pdfall-2":
                    case "pdfall-4":
                        // 보내기 메뉴는 고른 순서가 들쭉날쭉하니 이름 순서(1, 2, 10…)로 묶는다
                        Safe(r, files[0], delegate { ImagesToOnePdf(r, Paths.Natural(files.Where(Kinds.IsImage)), MarginOf(id), PerPageOf(id)); }); break;
                    case "rotr":
                    case "rotl":
                        each(files.Where(Kinds.IsImage), delegate (string f) { r.Made.Add(Pictures.Rotate(f, id == "rotr")); });
                        break;
                    case "pdfjpg":
                        {
                            var pdfs = files.Where(Kinds.IsPdfFile).ToList();
                            for (int i = 0; i < pdfs.Count && !r.Cancelled; i++)
                            {
                                if (stop != null && stop())
                                {
                                    r.Notes.Insert(0, "취소했어요. " + (pdfs.Count - i) + "개는 하지 않았어요.");
                                    r.Cancelled = true;
                                    break;
                                }
                                var f = pdfs[i];
                                int fi = i;
                                string name = Path.GetFileName(f);
                                Safe(r, f, delegate
                                {
                                    PdfPages.ToJpg(r, f, delegate (int p, int n)
                                    {
                                        if (progress == null) return;
                                        if (pdfs.Count == 1) progress(p, n, name);
                                        else progress(fi + 1, pdfs.Count, name + " · " + p + "/" + n + "쪽");
                                    }, stop);
                                });
                            }
                            break;
                        }
                    case "shrink":
                    case "shrink-s":
                    case "shrink-l":
                        {
                            int side = ShrinkSide(id);
                            long before = 0, after = 0; int done = 0;
                            each(files.Where(Kinds.IsImage), delegate (string f) { long b, a; if (Shrink(r, f, side, out b, out a)) { before += b; after += a; done++; } });
                            if (done > 1) r.Notes.Insert(r.Cancelled ? 1 : 0, done + "장 합계 " + Paths.Size(before) + " → " + Paths.Size(after));
                            break;
                        }
                    case "tojpg":
                        each(files.Where(x => Kinds.IsImage(x) && !Kinds.IsJpg(x)), delegate (string f)
                        {
                            byte[] jpg;
                            using (var img = Pictures.LoadUpright(f)) jpg = Pictures.Jpeg(img, 0, 90);
                            string outPath = Paths.Beside(f, "", ".jpg");
                            File.WriteAllBytes(outPath, jpg);
                            r.Made.Add(outPath);
                        });
                        break;
                    case "zip": Safe(r, files[0], delegate { r.Made.Add(Zipper.Pack(files)); }); break;
                    case "unzip": each(files, delegate (string f) { r.Made.Add(Zipper.Unpack(f)); }); break;
                    default: r.Problems.Add("모르는 동작: " + id); break;
                }
            }
            catch (Exception ex) { r.Problems.Add(Friendly(ex)); }
            return r;
        }

        /// 그림 줄이기 크기: 작게 1024 · 보통 1600 · 크게 2560 (긴 쪽 픽셀)
        public static int ShrinkSide(string id)
        {
            return id == "shrink-s" ? 1024 : id == "shrink-l" ? 2560 : 1600;
        }

        /// 그림 → PDF 여백(포인트): 보통 28(약 1cm) · 좁게 10 · 없음 0
        public static double MarginOf(string id)
        {
            return id.EndsWith("-n") ? 10 : id.EndsWith("-0") ? 0 : 28;
        }

        /// 한 쪽에 몇 장: pdfall-2 · pdfall-4
        public static int PerPageOf(string id)
        {
            return id.EndsWith("-2") ? 2 : id.EndsWith("-4") ? 4 : 1;
        }

        static void Safe(JobResult r, string f, Action a)
        {
            try { a(); }
            catch (Exception ex)
            {
                r.Problems.Add(Path.GetFileName(f) + ": " + Friendly(ex));
                if (Environment.GetEnvironmentVariable("TUK_DEBUG") == "1") Console.Error.WriteLine(ex.ToString());
            }
        }

        /// 오류를 무엇을 하면 되는지 알 수 있는 말로 바꾼다
        public static string Friendly(Exception ex)
        {
            var e = ex is System.Reflection.TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
            if (e is UnauthorizedAccessException)
                return "이 폴더에는 새 파일을 만들 수 없어요. 파일을 바탕화면 같은 곳으로 옮겨서 다시 해 보세요.";
            if (e is FileNotFoundException || e is DirectoryNotFoundException)
                return "파일을 찾지 못했어요. 옮겨지거나 지워지지 않았는지 확인해 주세요.";
            if (e is PathTooLongException)
                return "폴더 경로가 너무 길어요. 파일을 바탕화면 같은 짧은 경로로 옮겨서 해 보세요.";
            if (e is InvalidDataException)
                return "압축 파일이 손상됐거나 ZIP 형식이 아니에요.";
            if (e is IOException)
            {
                int code = e.HResult & 0xFFFF;
                if (code == 32 || code == 33) return "다른 프로그램이 이 파일을 쓰고 있어요. 그 프로그램을 닫고 다시 해 보세요.";
                if (code == 112 || code == 39) return "디스크 공간이 모자라요. 공간을 비우고 다시 해 보세요.";
            }
            if (e is COMException || e is InvalidComObjectException || e is Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
                return "문서 프로그램(한글·워드 등)이 바꾸는 도중 멈췄어요. 열려 있는 알림 창이 있으면 닫고 다시 해 보세요.";
            if (e is OutOfMemoryException)
                return "파일이 너무 커서 처리하지 못했어요.";
            return e.Message;
        }

        static void ToPdf(JobResult r, string f, double margin)
        {
            if (!Kinds.ToPdf(f)) { r.Notes.Add(Path.GetFileName(f) + "은(는) PDF로 바꿀 수 없어서 건너뛰었어요."); return; }
            string outPath = Paths.Beside(f, "", ".pdf");
            if (Kinds.IsImage(f)) Pdf.FromImages(outPath, new List<string> { f }, margin);
            else Office.ToPdf(f, outPath);
            r.Made.Add(outPath);
        }

        static void ImagesToOnePdf(JobResult r, List<string> imgs, double margin, int per)
        {
            string outPath = Paths.Beside(imgs[0], per > 1 ? "_한쪽에" + per + "장" : "_묶음", ".pdf");
            Pdf.FromImages(outPath, imgs, margin, per);
            r.Made.Add(outPath);
        }

        static bool Shrink(JobResult r, string f, int side, out long before, out long after)
        {
            before = new FileInfo(f).Length;
            byte[] jpg;
            using (var img = Pictures.LoadUpright(f)) jpg = Pictures.Jpeg(img, side, 80);
            after = jpg.Length;
            // 아이폰 사진(HEIC)은 JPG가 더 커도 바꾼다. 어디서나 열리는 JPG가 목적이다.
            if (Kinds.IsHeic(f))
            {
                string heicOut = Paths.Beside(f, "_줄임", ".jpg");
                File.WriteAllBytes(heicOut, jpg);
                r.Made.Add(heicOut);
                r.Notes.Add(Path.GetFileName(f) + " → JPG " + Paths.Size(jpg.Length));
                return false;
            }
            if (jpg.Length >= before)
            {
                r.Notes.Add(Path.GetFileName(f) + "은(는) 이미 충분히 작아요.");
                return false;
            }
            string outPath = Paths.Beside(f, "_줄임", ".jpg");
            File.WriteAllBytes(outPath, jpg);
            r.Made.Add(outPath);
            r.Notes.Add(Path.GetFileName(f) + ": " + Paths.Size(before) + " → " + Paths.Size(jpg.Length));
            return true;
        }
    }

    static class Paths
    {
        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] static extern int StrCmpLogicalW(string a, string b);

        /// 탐색기와 같은 이름 순서 (사진2가 사진10보다 앞)
        public static List<string> Natural(IEnumerable<string> files)
        {
            var list = files.ToList();
            list.Sort((a, b) => StrCmpLogicalW(Path.GetFileName(a), Path.GetFileName(b)));
            return list;
        }

        /// 원본 옆에 겹치지 않는 새 이름. 겹치면 ' (2)'를 붙인다.
        public static string Beside(string original, string suffix, string ext)
        {
            string dir = Path.GetDirectoryName(Path.GetFullPath(original));
            string stem = Path.GetFileNameWithoutExtension(original) + suffix;
            return Unique(dir, stem, ext);
        }

        public static string Unique(string dir, string stem, string ext)
        {
            string p = Path.Combine(dir, stem + ext);
            for (int i = 2; File.Exists(p) || Directory.Exists(p); i++) p = Path.Combine(dir, stem + " (" + i + ")" + ext);
            return p;
        }

        public static string Size(long b)
        {
            if (b >= 1024 * 1024) return (b / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + "MB";
            return Math.Max(1, b / 1024) + "KB";
        }
    }

    // ───────────── 그림 ─────────────
    static class Pictures
    {
        /// 사진의 회전 정보(EXIF)를 반영해 바로 선 그림으로 읽는다. 파일은 잠그지 않는다.
        public static Image LoadUpright(string path)
        {
            if (Kinds.IsHeic(path)) return LoadHeic(path);
            Image img;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var src = Open(fs))
            {
                img = new Bitmap(src);
                if (src.PropertyIdList.Contains(0x0112))
                    Orient(img, BitConverter.ToUInt16(src.GetPropertyItem(0x0112).Value, 0));
            }
            return img;
        }

        static void Orient(Image img, int o)
        {
            RotateFlipType t;
            switch (o)
            {
                case 2: t = RotateFlipType.RotateNoneFlipX; break;
                case 3: t = RotateFlipType.Rotate180FlipNone; break;
                case 4: t = RotateFlipType.Rotate180FlipX; break;
                case 5: t = RotateFlipType.Rotate90FlipX; break;
                case 6: t = RotateFlipType.Rotate90FlipNone; break;
                case 7: t = RotateFlipType.Rotate270FlipX; break;
                case 8: t = RotateFlipType.Rotate270FlipNone; break;
                default: return;
            }
            img.RotateFlip(t);
        }

        public const string HeicHelp = "아이폰 사진(HEIC)을 읽지 못했어요. Microsoft Store에서 'HEIF 이미지 확장'과 'HEVC 비디오 확장'을 설치하면 읽을 수 있어요.";

        /// 아이폰 사진(HEIC)은 윈도우 그림 부품(WIC)으로 읽는다. HEIF·HEVC 확장이 있어야 한다.
        static Image LoadHeic(string path)
        {
            Wic.BitmapFrame frame;
            int orient = 1;
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    var dec = Wic.BitmapDecoder.Create(fs, Wic.BitmapCreateOptions.PreservePixelFormat, Wic.BitmapCacheOption.OnLoad);
                    frame = dec.Frames[0];
                    try
                    {
                        var md = frame.Metadata as Wic.BitmapMetadata;
                        object o = md != null ? md.GetQuery("System.Photo.Orientation") : null;
                        if (o != null) orient = Convert.ToInt32(o, CultureInfo.InvariantCulture);
                    }
                    catch { /* 회전 정보가 없으면 그대로 */ }
                }
            }
            catch (Exception ex)
            {
                if (Environment.GetEnvironmentVariable("TUK_DEBUG") == "1") Console.Error.WriteLine(ex.ToString());
                throw new Exception(HeicHelp);
            }
            var enc = new Wic.BmpBitmapEncoder();
            enc.Frames.Add(Wic.BitmapFrame.Create(new Wic.FormatConvertedBitmap(frame, System.Windows.Media.PixelFormats.Bgr24, null, 0)));
            using (var ms = new MemoryStream())
            {
                enc.Save(ms);
                ms.Position = 0;
                Bitmap img;
                using (var tmp = new Bitmap(ms)) img = new Bitmap(tmp);
                Orient(img, orient);
                return img;
            }
        }

        static Image Open(Stream s)
        {
            try { return Image.FromStream(s); }
            catch (ArgumentException) { throw new Exception("그림 파일이 손상됐거나 읽을 수 없는 형식이에요."); }
            catch (OutOfMemoryException) { throw new Exception("그림 파일이 손상됐거나 읽을 수 없는 형식이에요."); }
        }

        /// 90도 돌린 새 파일을 원본 옆에 만든다. 사진(JPG·HEIC)은 JPG로, 나머지는 화질 손실 없는 PNG로.
        public static string Rotate(string path, bool right)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            bool photo = ext == ".jpg" || ext == ".jpeg" || Kinds.IsHeic(path);
            using (var img = LoadUpright(path))
            {
                img.RotateFlip(right ? RotateFlipType.Rotate90FlipNone : RotateFlipType.Rotate270FlipNone);
                string outPath = Paths.Beside(path, "_돌림", photo ? ".jpg" : ".png");
                if (photo) File.WriteAllBytes(outPath, Jpeg(img, 0, 92));
                else img.Save(outPath, ImageFormat.Png);
                return outPath;
            }
        }

        /// 흰 바탕 위에 다시 그려 JPEG로. maxSide 0이면 크기 그대로.
        public static byte[] Jpeg(Image img, int maxSide, long quality)
        {
            int w = img.Width, h = img.Height;
            if (maxSide > 0 && Math.Max(w, h) > maxSide)
            {
                double s = (double)maxSide / Math.Max(w, h);
                w = Math.Max(1, (int)Math.Round(w * s));
                h = Math.Max(1, (int)Math.Round(h * s));
            }
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.White);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(img, new Rectangle(0, 0, w, h));
                }
                var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                using (var ps = new EncoderParameters(1))
                using (var ms = new MemoryStream())
                {
                    ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                    bmp.Save(ms, codec, ps);
                    return ms.ToArray();
                }
            }
        }
    }

    // ───────────── PDF (그림 → PDF는 직접 쓴다) ─────────────
    static class Pdf
    {
        const double A4W = 595.28, A4H = 841.89;

        public static void FromImages(string outPath, IList<string> images, double Margin, int perPage = 1)
        {
            string tmp = outPath + ".part";
            var offsets = new Dictionary<int, long>();
            var kids = new List<int>();
            // 한 쪽에 여러 장이면 세로 A4에 격자로 (왼쪽 위부터 오른쪽으로)
            int per = perPage == 2 || perPage == 4 || perPage == 6 || perPage == 9 ? perPage : 1;
            int cols = per == 4 || per == 6 ? 2 : per == 9 ? 3 : 1;
            int rows = per == 2 || per == 4 ? 2 : per == 6 || per == 9 ? 3 : 1;
            double gap = Margin > 0 ? 10 : 4;
            try
            {
                using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                {
                    var w = new PdfOut(fs);
                    w.Raw("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
                    offsets[1] = w.Pos; w.Raw("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
                    int next = 3;
                    for (int start = 0; start < images.Count; start += per)
                    {
                        double pw = A4W, ph = A4H;
                        var content = new StringBuilder();
                        var res = new StringBuilder();
                        int count = Math.Min(per, images.Count - start);
                        for (int k = 0; k < count; k++)
                        {
                            byte[] jpg; int iw, ih;
                            int maxSide = per > 1 ? 2000 : 0;
                            using (var img = Pictures.LoadUpright(images[start + k]))
                            {
                                jpg = Pictures.Jpeg(img, maxSide, per > 1 ? 85 : 90);
                                iw = img.Width; ih = img.Height;
                                // Pictures.Jpeg와 같은 셈으로 줄어든 크기
                                if (maxSide > 0 && Math.Max(iw, ih) > maxSide)
                                {
                                    double k2 = (double)maxSide / Math.Max(iw, ih);
                                    iw = Math.Max(1, (int)Math.Round(iw * k2));
                                    ih = Math.Max(1, (int)Math.Round(ih * k2));
                                }
                            }
                            double cx, cy, cw, ch;
                            if (per == 1)
                            {
                                bool land = iw > ih;
                                pw = land ? A4H : A4W; ph = land ? A4W : A4H;
                                cx = Margin; cy = Margin; cw = pw - 2 * Margin; ch = ph - 2 * Margin;
                            }
                            else
                            {
                                cw = (pw - 2 * Margin - (cols - 1) * gap) / cols;
                                ch = (ph - 2 * Margin - (rows - 1) * gap) / rows;
                                int col = k % cols, row = k / cols;
                                cx = Margin + col * (cw + gap);
                                cy = ph - Margin - (row + 1) * ch - row * gap;
                            }
                            double s = Math.Min(cw / iw, ch / ih);
                            double dw = iw * s, dh = ih * s, x = cx + (cw - dw) / 2, y = cy + (ch - dh) / 2;

                            int imgId = next++;
                            offsets[imgId] = w.Pos;
                            w.Raw(imgId + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + iw + " /Height " + ih +
                                  " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpg.Length + " >>\nstream\n");
                            w.Bytes(jpg);
                            w.Raw("\nendstream\nendobj\n");
                            content.Append("q " + N(dw) + " 0 0 " + N(dh) + " " + N(x) + " " + N(y) + " cm /Im" + k + " Do Q\n");
                            res.Append("/Im" + k + " " + imgId + " 0 R ");
                        }
                        int contentId = next++, pageId = next++;
                        string c = content.ToString();
                        offsets[contentId] = w.Pos;
                        w.Raw(contentId + " 0 obj\n<< /Length " + c.Length + " >>\nstream\n" + c + "endstream\nendobj\n");

                        offsets[pageId] = w.Pos;
                        w.Raw(pageId + " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + N(pw) + " " + N(ph) + "] " +
                              "/Resources << /XObject << " + res + ">> >> /Contents " + contentId + " 0 R >>\nendobj\n");
                        kids.Add(pageId);
                    }
                    offsets[2] = w.Pos;
                    w.Raw("2 0 obj\n<< /Type /Pages /Count " + kids.Count + " /Kids [" + string.Join(" ", kids.Select(k => k + " 0 R")) + "] >>\nendobj\n");

                    int size = next;
                    long xref = w.Pos;
                    var sb = new StringBuilder();
                    sb.Append("xref\n0 ").Append(size).Append("\n0000000000 65535 f \n");
                    for (int i = 1; i < size; i++) sb.Append(offsets[i].ToString("D10", CultureInfo.InvariantCulture)).Append(" 00000 n \n");
                    sb.Append("trailer\n<< /Size ").Append(size).Append(" /Root 1 0 R >>\nstartxref\n").Append(xref).Append("\n%%EOF\n");
                    w.Raw(sb.ToString());
                }
                File.Move(tmp, outPath);
            }
            finally
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
        }

        static string N(double v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }

        sealed class PdfOut
        {
            readonly Stream s;
            public PdfOut(Stream s) { this.s = s; }
            public long Pos { get { return s.Position; } }
            public void Raw(string t) { var b = Encoding.GetEncoding(28591).GetBytes(t); s.Write(b, 0, b.Length); }
            public void Bytes(byte[] b) { s.Write(b, 0, b.Length); }
        }
    }

    // ───────────── 한글·오피스 → PDF (PC에 깔린 프로그램을 COM으로 부른다) ─────────────
    // ───────────── PDF → JPG (윈도우에 들어 있는 PDF 그리기 기능, Windows.Data.Pdf) ─────────────
    static class PdfPages
    {
        const int Dpi = 150, MaxSide = 3000, MaxPages = 500;

        // 윈도우 비동기 작업을 끝날 때까지 기다린다 (C# 5 기본 컴파일러에는 AsTask 도우미가 없다)
        static T Wait<T>(WinAsync.IAsyncOperation<T> op)
        {
            while (op.Status == WinAsync.AsyncStatus.Started) Thread.Sleep(5);
            if (op.Status != WinAsync.AsyncStatus.Completed) throw op.ErrorCode ?? new Exception("PDF를 읽지 못했어요.");
            return op.GetResults();
        }
        static void Wait(WinAsync.IAsyncAction op)
        {
            while (op.Status == WinAsync.AsyncStatus.Started) Thread.Sleep(5);
            if (op.Status != WinAsync.AsyncStatus.Completed) throw op.ErrorCode ?? new Exception("PDF 쪽을 그리지 못했어요.");
        }

        static WinPdf.PdfDocument Open(string path)
        {
            try
            {
                var file = Wait(Windows.Storage.StorageFile.GetFileFromPathAsync(Path.GetFullPath(path)));
                return Wait(WinPdf.PdfDocument.LoadFromFileAsync(file));
            }
            catch (Exception ex)
            {
                if (Environment.GetEnvironmentVariable("TUK_DEBUG") == "1") Console.Error.WriteLine(ex.ToString());
                if (ex is FileNotFoundException || ex is UnauthorizedAccessException) throw;
                if ((ex.HResult & 0xFFFF) == 0x52B) throw new Exception("암호가 걸린 PDF라서 열 수 없어요.");
                // AES-256 암호 등 윈도우 PDF 기능이 못 여는 방식
                if (ex.HResult == unchecked((int)0x80048040)) throw new Exception("암호가 걸렸거나 윈도우가 읽지 못하는 방식의 PDF예요.");
                throw new Exception("PDF가 손상됐거나 읽을 수 없어요.");
            }
        }

        /// 쪽마다 JPG 한 장. 한 쪽이면 PDF 옆에, 여러 쪽이면 새 폴더에 넣는다.
        public static void ToJpg(JobResult r, string path, Action<int, int> progress, Func<bool> stop)
        {
            var doc = Open(path);
            int n = (int)doc.PageCount;
            if (n == 0) throw new Exception("쪽이 없는 PDF예요.");
            if (n > MaxPages) throw new Exception("쪽이 너무 많아요 (" + MaxPages + "쪽까지).");
            string stem = Path.GetFileNameWithoutExtension(path);
            string dir = null;
            if (n > 1)
            {
                dir = Paths.Unique(Path.GetDirectoryName(Path.GetFullPath(path)), stem + "_그림", "");
                Directory.CreateDirectory(dir);
            }
            int width = Math.Max(2, n.ToString(CultureInfo.InvariantCulture).Length);
            for (int i = 0; i < n; i++)
            {
                if (stop != null && stop())
                {
                    r.Notes.Insert(0, "취소했어요. " + Path.GetFileName(path) + "은(는) " + i + "쪽까지만 바꿨어요.");
                    r.Cancelled = true;
                    break;
                }
                if (progress != null) progress(i + 1, n);
                byte[] jpg = Page(doc, (uint)i);
                string outPath = dir == null
                    ? Paths.Beside(path, "", ".jpg")
                    : Path.Combine(dir, stem + "_" + (i + 1).ToString("D" + width, CultureInfo.InvariantCulture) + "쪽.jpg");
                File.WriteAllBytes(outPath, jpg);
                if (dir == null) r.Made.Add(outPath);
            }
            if (dir != null)
            {
                if (Directory.EnumerateFiles(dir).Any()) r.Made.Add(dir);
                else Directory.Delete(dir);
            }
        }

        static byte[] Page(WinPdf.PdfDocument doc, uint index)
        {
            using (var page = doc.GetPage(index))
            {
                // page.Size는 1/96인치 단위, 돌려 둔 쪽은 돌린 뒤 크기
                double w = page.Size.Width, h = page.Size.Height;
                double scale = Math.Min(Dpi / 96.0, MaxSide / Math.Max(w, h));
                var o = new WinPdf.PdfPageRenderOptions
                {
                    DestinationWidth = (uint)Math.Max(1, Math.Round(w * scale)),
                    DestinationHeight = (uint)Math.Max(1, Math.Round(h * scale)),
                };
                using (var st = new WinStreams.InMemoryRandomAccessStream())
                {
                    Wait(page.RenderToStreamAsync(st, o));
                    var buf = new byte[st.Size];
                    using (var rd = new WinStreams.DataReader(st.GetInputStreamAt(0)))
                    {
                        Wait(rd.LoadAsync((uint)st.Size));
                        rd.ReadBytes(buf);
                    }
                    using (var ms = new MemoryStream(buf))
                    using (var img = Image.FromStream(ms))
                        return Pictures.Jpeg(img, 0, 90);
                }
            }
        }
    }

    static class Office
    {
        public static void ToPdf(string src, string outPath)
        {
            string full = Path.GetFullPath(src);
            try
            {
                if (Kinds.IsHwp(src)) Hwp(full, outPath);
                else if (Kinds.IsWord(src)) Word(full, outPath);
                else if (Kinds.IsExcel(src)) Excel(full, outPath);
                else if (Kinds.IsPpt(src)) PowerPoint(full, outPath);
            }
            finally
            {
                // 중간에 생긴 COM 개체(Workbooks 등)까지 놓아야 엑셀이 끝난다
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
            if (!File.Exists(outPath)) throw new Exception("PDF가 만들어지지 않았어요.");
        }

        static dynamic Create(string progId, string missing)
        {
            var t = Type.GetTypeFromProgID(progId);
            if (t == null) throw new Exception(missing);
            return Activator.CreateInstance(t);
        }

        static void Release(object o)
        {
            if (o != null && Marshal.IsComObject(o)) { try { Marshal.FinalReleaseComObject(o); } catch { } }
        }

        static void Word(string src, string outPath)
        {
            dynamic app = Create("Word.Application", "MS 워드가 없어서 바꾸지 못했어요.");
            dynamic doc = null;
            // 이미 켜진 워드에 붙었으면(선생님이 쓰던 문서가 있으면) 끄지 않는다
            bool ours = OpenCount(delegate { return app.Documents.Count; }) == 0;
            try
            {
                if (ours) app.Visible = false;
                app.DisplayAlerts = 0;
                doc = app.Documents.Open(src, false, true, false, Visible: false);
                doc.ExportAsFixedFormat(outPath, 17); // wdExportFormatPDF
            }
            finally
            {
                if ((object)doc != null) { try { doc.Close(0); } catch { } Release((object)doc); }
                if (ours) { try { app.Quit(0); } catch { } }
                Release((object)app);
            }
        }

        static void Excel(string src, string outPath)
        {
            dynamic app = Create("Excel.Application", "MS 엑셀이 없어서 바꾸지 못했어요.");
            dynamic wb = null;
            bool ours = OpenCount(delegate { return app.Workbooks.Count; }) == 0;
            try
            {
                if (ours) app.Visible = false;
                app.DisplayAlerts = false;
                wb = app.Workbooks.Open(src, 0, true);
                wb.ExportAsFixedFormat(0, outPath); // xlTypePDF
            }
            finally
            {
                if ((object)wb != null) { try { wb.Close(false); } catch { } Release((object)wb); }
                if (ours) { try { app.Quit(); } catch { } }
                Release((object)app);
            }
        }

        static void PowerPoint(string src, string outPath)
        {
            dynamic app = Create("PowerPoint.Application", "MS 파워포인트가 없어서 바꾸지 못했어요.");
            dynamic p = null;
            // 파워포인트는 늘 하나만 켜진다. 쓰던 발표 자료가 있으면 끄지 않는다.
            bool ours = OpenCount(delegate { return app.Presentations.Count; }) == 0;
            try
            {
                p = app.Presentations.Open(src, -1, 0, 0); // ReadOnly, Untitled 아님, 창 없이
                p.SaveAs(outPath, 32); // ppSaveAsPDF
            }
            finally
            {
                if ((object)p != null) { try { p.Close(); } catch { } Release((object)p); }
                if (ours) { try { app.Quit(); } catch { } }
                Release((object)app);
            }
        }

        /// 열린 문서 수. 알 수 없으면 1(= 쓰던 것이 있다고 보고 끄지 않음).
        static int OpenCount(Func<int> count)
        {
            try { return count(); } catch { return 1; }
        }

        static void Hwp(string src, string outPath)
        {
            dynamic hwp = Create("HWPFrame.HwpObject", "한컴오피스 한글이 없어서 바꾸지 못했어요.");
            try
            {
                try { hwp.XHwpWindows.Item(0).Visible = false; } catch { }
                // 한글이 '접근하려는 시도' 보안 창을 띄우면 [접근 허용]을 눌러야 한다.
                bool opened = hwp.Open(src, "", "forceopen:true;versionwarning:false");
                if (!opened) throw new Exception("한글이 파일을 열지 못했어요.");
                bool saved = hwp.SaveAs(outPath, "PDF", "");
                if (!saved) throw new Exception("한글이 PDF로 저장하지 못했어요.");
            }
            finally
            {
                try { hwp.Clear(1); } catch { }
                try { hwp.Quit(); } catch { }
                Release((object)hwp);
            }
        }
    }

    // ───────────── 압축 ─────────────
    static class Zipper
    {
        public static string Pack(IList<string> items)
        {
            string first = items[0].TrimEnd('\\', '/');
            string dir = Path.GetDirectoryName(Path.GetFullPath(first));
            string stem = Path.GetFileNameWithoutExtension(first);
            if (Directory.Exists(first)) stem = Path.GetFileName(first);
            if (items.Count > 1) stem += " 외 " + (items.Count - 1) + "개";
            string outPath = Paths.Unique(dir, stem, ".zip");
            string tmp = outPath + ".part";
            try
            {
                using (var fs = new FileStream(tmp, FileMode.Create))
                using (var zip = new ZipArchive(fs, ZipArchiveMode.Create, false, Encoding.UTF8))
                {
                    foreach (var raw in items)
                    {
                        string it = Path.GetFullPath(raw.TrimEnd('\\', '/'));
                        if (File.Exists(it)) zip.CreateEntryFromFile(it, Path.GetFileName(it), CompressionLevel.Optimal);
                        else if (Directory.Exists(it))
                        {
                            string root = Path.GetDirectoryName(it);
                            foreach (var f in Directory.GetFiles(it, "*", SearchOption.AllDirectories))
                                zip.CreateEntryFromFile(f, f.Substring(root.Length + 1).Replace('\\', '/'), CompressionLevel.Optimal);
                        }
                    }
                }
                File.Move(tmp, outPath);
            }
            finally
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
            return outPath;
        }

        public static string Unpack(string zipPath)
        {
            string dir = Path.GetDirectoryName(Path.GetFullPath(zipPath));
            string dest = Paths.Unique(dir, Path.GetFileNameWithoutExtension(zipPath), "");
            string destFull = Path.GetFullPath(dest) + Path.DirectorySeparatorChar;
            // UTF-8 표시가 없는 이름은 윈도우·알집이 흔히 쓰는 CP949로 읽는다.
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Read, Encoding.GetEncoding(949)))
            {
                // 하나라도 폴더 밖을 가리키면(../) 아무것도 풀지 않는다
                var targets = new List<KeyValuePair<ZipArchiveEntry, string>>();
                foreach (var e in zip.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(dest, e.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(destFull, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("폴더 밖을 가리키는 항목이 있어서 풀지 않았어요: " + e.FullName);
                    targets.Add(new KeyValuePair<ZipArchiveEntry, string>(e, target));
                }
                Directory.CreateDirectory(dest);
                foreach (var t in targets)
                {
                    if (t.Key.FullName.EndsWith("/") || t.Key.Name.Length == 0) { Directory.CreateDirectory(t.Value); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(t.Value));
                    t.Key.ExtractToFile(t.Value, false);
                }
            }
            return dest;
        }
    }

    // ───────────── 설치 (관리자 권한 없이 내 계정에만) ─────────────
    static class Installer
    {
        public static bool Installed { get { return File.Exists(AppInfo.SendToLink); } }

        public static void Install()
        {
            Directory.CreateDirectory(AppInfo.InstallDir);
            string me = Application.ExecutablePath;
            if (!string.Equals(Path.GetFullPath(me), Path.GetFullPath(AppInfo.InstalledExe), StringComparison.OrdinalIgnoreCase))
                File.Copy(me, AppInfo.InstalledExe, true);
            Shortcut(AppInfo.SendToLink, "파일을 툭 놓으면 PDF·용량 줄이기·압축");
            Shortcut(AppInfo.StartLink, "툭 — 파일을 놓는 창 열기");
        }

        public static void Uninstall()
        {
            foreach (var l in new[] { AppInfo.SendToLink, AppInfo.StartLink }) if (File.Exists(l)) File.Delete(l);
            string me = Path.GetFullPath(Application.ExecutablePath);
            if (Directory.Exists(AppInfo.InstallDir))
            {
                if (me.StartsWith(Path.GetFullPath(AppInfo.InstallDir), StringComparison.OrdinalIgnoreCase))
                {
                    // 실행 중인 자기 자신은 지울 수 없으니, 끝난 뒤 지운다
                    var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                        "/d /c ping -n 3 127.0.0.1 >nul & rd /s /q \"" + AppInfo.InstallDir + "\"")
                    { CreateNoWindow = true, UseShellExecute = false };
                    Process.Start(psi);
                }
                else Directory.Delete(AppInfo.InstallDir, true);
            }
        }

        static void Shortcut(string lnk, string desc)
        {
            dynamic sh = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            try
            {
                dynamic s = sh.CreateShortcut(lnk);
                s.TargetPath = AppInfo.InstalledExe;
                s.WorkingDirectory = AppInfo.InstallDir;
                s.Description = desc;
                s.Save();
                Marshal.FinalReleaseComObject((object)s);
            }
            finally { Marshal.FinalReleaseComObject((object)sh); }
        }
    }

    // ───────────── 화면 ─────────────
    static class Ui
    {
        public static readonly Color Paper = Color.FromArgb(246, 243, 238);
        public static readonly Color Ink = Color.FromArgb(40, 36, 32);
        public static readonly Color Accent = Color.FromArgb(232, 110, 60);
        public static readonly Color Soft = Color.FromArgb(255, 236, 224);
        public static readonly Font Body = new Font("맑은 고딕", 10f);
        public static readonly Font Title = new Font("맑은 고딕", 13f, FontStyle.Bold);
        public static readonly Font Small = new Font("맑은 고딕", 8.5f);
        public static readonly Font SmallBold = new Font("맑은 고딕", 8.5f, FontStyle.Bold);

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        /// 화면 배율(125%·150%)에서도 글자가 흐리지 않게. 창을 만들기 전에 부른다.
        public static void UseSharpText()
        {
            try { SetProcessDPIAware(); } catch { }
        }

        static float scale;
        /// 100% 화면 기준 픽셀을 지금 화면 배율에 맞춘다
        public static int Px(int n)
        {
            if (scale == 0)
            {
                try { using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f; }
                catch { scale = 1; }
                if (scale < 1) scale = 1;
            }
            return (int)Math.Round(n * scale);
        }
        public static Point P(int x, int y) { return new Point(Px(x), Px(y)); }
        public static Size S(int w, int h) { return new Size(Px(w), Px(h)); }

        public static ContextMenuStrip Menu(IList<string> files, Action<string> chosen)
        {
            var m = new ContextMenuStrip { Font = Body, ShowImageMargin = false };
            var head = new ToolStripLabel(files.Count == 1 ? Path.GetFileName(files[0].TrimEnd('\\')) : "파일 " + files.Count + "개")
            { Font = Small, ForeColor = Color.Gray };
            m.Items.Add(head);
            m.Items.Add(new ToolStripSeparator());
            int n = 1;
            foreach (var c in Choices.For(files))
            {
                var choice = c;
                var item = new ToolStripMenuItem("&" + n + "  " + c.Label) { ToolTipText = c.Hint };
                if (c.Id == "shrink")
                {
                    // 크기 고르기: 숫자 키로도 고른다
                    var sizes = new[]
                    {
                        new[] { "shrink-s", "&1  작게 · 1024픽셀", "메신저·알림장에 많이 올릴 때" },
                        new[] { "shrink",   "&2  보통 · 1600픽셀", "메일·문서에 넣을 때" },
                        new[] { "shrink-l", "&3  크게 · 2560픽셀", "인쇄하거나 크게 볼 때" },
                    };
                    foreach (var s in sizes)
                    {
                        var id = s[0];
                        var sub = new ToolStripMenuItem(s[1]) { ToolTipText = s[2] };
                        sub.Click += delegate { chosen(id); };
                        item.DropDownItems.Add(sub);
                    }
                }
                else if (c.Id == "rotate")
                {
                    var dirs = new[]
                    {
                        new[] { "rotr", "&1  오른쪽으로 90°", "시계 방향" },
                        new[] { "rotl", "&2  왼쪽으로 90°", "시계 반대 방향" },
                    };
                    foreach (var s in dirs)
                    {
                        var id = s[0];
                        var sub = new ToolStripMenuItem(s[1]) { ToolTipText = s[2] };
                        sub.Click += delegate { chosen(id); };
                        item.DropDownItems.Add(sub);
                    }
                }
                else if ((c.Id == "pdf" && files.Where(Kinds.ToPdf).All(Kinds.IsImage)) || c.Id == "pdfall")
                {
                    // 그림 → PDF 여백 고르기. 위 항목을 바로 누르면 '보통'.
                    var margins = new[]
                    {
                        new[] { "",   "&1  여백 보통", "A4에 1cm쯤 여백 · 인쇄하기 좋아요" },
                        new[] { "-n", "&2  여백 좁게", "그림을 조금 더 크게" },
                        new[] { "-0", "&3  여백 없이", "A4 가득 · 남는 쪽만 흰 띠" },
                    };
                    foreach (var s in margins)
                    {
                        var id = c.Id + s[0];
                        var sub = new ToolStripMenuItem(s[1]) { ToolTipText = s[2] };
                        sub.Click += delegate { chosen(id); };
                        item.DropDownItems.Add(sub);
                    }
                    if (c.Id == "pdfall")
                    {
                        // 한 쪽에 여러 장 (사진 모아 찍기)
                        item.DropDownItems.Add(new ToolStripSeparator());
                        var grids = new[]
                        {
                            new[] { "-2", "&4  한 쪽에 2장", "A4 한 쪽에 위아래로 2장씩" },
                            new[] { "-4", "&5  한 쪽에 4장", "A4 한 쪽에 2×2로 4장씩" },
                        };
                        foreach (var s in grids)
                        {
                            var id = c.Id + s[0];
                            var sub = new ToolStripMenuItem(s[1]) { ToolTipText = s[2] };
                            sub.Click += delegate { chosen(id); };
                            item.DropDownItems.Add(sub);
                        }
                    }
                    item.Click += delegate { chosen(choice.Id); m.Close(); };
                }
                else if (c.Id == "pdfweb")
                {
                    // PDF 손질은 웹 버전에서 한다. 파일이 있는 폴더도 같이 열어 끌어다 놓기 쉽게.
                    item.Click += delegate
                    {
                        try { Process.Start(new ProcessStartInfo(Updater.Site + "#web") { UseShellExecute = true }); } catch { }
                        try { Process.Start("explorer.exe", "/select,\"" + files.First(Kinds.IsPdfFile) + "\""); } catch { }
                    };
                }
                else item.Click += delegate { chosen(choice.Id); };
                m.Items.Add(item);
                n++;
            }
            return m;
        }

        static string LabelOf(string id, IList<string> files)
        {
            if (id.StartsWith("shrink")) return "그림 용량 줄이기";
            if (id == "rotr" || id == "rotl") return "그림 돌리기";
            if (id.StartsWith("pdfall")) id = "pdfall";
            else if (id.StartsWith("pdf-")) id = "pdf";
            return Choices.For(files).Where(c => c.Id == id).Select(c => c.Label).FirstOrDefault() ?? id;
        }

        /// 일을 STA 스레드(오피스 COM에 필요)에서 하고, 끝나면 알림을 띄운다.
        public static void RunWithToast(string id, IList<string> files, Action done)
        {
            var label = LabelOf(id, files);
            int stop = 0;
            var busy = Toast.Busy(label + " 하는 중…", files.Count > 1 ? "파일 " + files.Count + "개 · 잠시만 기다려 주세요." : "잠시만 기다려 주세요.",
                files.Count > 1 || id == "pdfjpg" ? (Action)delegate { Interlocked.Exchange(ref stop, 1); } : null);
            busy.Show();
            var ui = SynchronizationContext.Current;
            var t = new Thread(delegate ()
            {
                var r = Jobs.Run(id, files,
                    delegate (int i, int n, string name) { ui.Post(delegate { busy.SetBody(i + " / " + n + " · " + name); }, null); },
                    delegate { return Volatile.Read(ref stop) == 1; });
                ui.Post(delegate
                {
                    busy.Close();
                    var toast = Toast.For(label, r);
                    toast.FormClosed += delegate { if (done != null) done(); };
                    toast.Show();
                }, null);
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }
    }

    /// 화면 오른쪽 아래 알림
    sealed class Toast : Form
    {
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();

        Label bodyLabel;
        Action cancel;

        /// 일하는 동안 보이는 알림. cancel을 주면 [취소]가 생긴다.
        public static Toast Busy(string title, string body, Action cancel)
        {
            var t = new Toast(title, body, null, null, false, true, cancel);
            return t;
        }

        public void SetBody(string text) { if (!IsDisposed && bodyLabel != null) bodyLabel.Text = text; }

        public static Toast For(string label, JobResult r)
        {
            string title;
            bool bad = r.Problems.Count > 0;
            if (r.Made.Count > 0 && !bad) title = "다 됐어요 · " + label;
            else if (r.Made.Count > 0) title = "일부만 됐어요 · " + label;
            else if (!bad) title = "바꿀 것이 없었어요 · " + label;
            else title = "하지 못했어요 · " + label;
            if (r.Cancelled) title = "멈췄어요 · " + label;

            var lines = new List<string>();
            if (r.Made.Count == 1) lines.Add(Path.GetFileName(r.Made[0]));
            else if (r.Made.Count > 1) lines.Add(r.Made.Count + "개 만들었어요");
            lines.AddRange(r.Problems.Take(3));
            if (r.Problems.Count > 3) lines.Add("그 밖에 문제 " + (r.Problems.Count - 3) + "개");
            lines.AddRange(r.Notes.Take(bad ? 1 : 3));

            // 하나면 그 파일을 열고, 여럿이면 폴더를 연다
            string open = r.Made.Count == 1 ? r.Made[0] : null;
            string reveal = r.Made.Count > 0 ? r.Made[0] : null;
            return new Toast(title, string.Join("\n", lines), open, reveal, bad && r.Made.Count == 0, false);
        }

        Toast(string title, string body, string open, string reveal, bool bad, bool busy, Action cancel = null)
        {
            this.cancel = cancel;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Ui.Paper;

            int w = Ui.Px(380), left = Ui.Px(22), inner = w - left - Ui.Px(18);
            var bodySize = TextRenderer.MeasureText(body.Length == 0 ? " " : body, Ui.Small, new Size(inner, 0), TextFormatFlags.WordBreak);
            int bodyH = Math.Min(bodySize.Height + Ui.Px(4), Ui.Px(140));

            var bar = new Panel { Dock = DockStyle.Left, Width = Ui.Px(6), BackColor = bad ? Color.IndianRed : Ui.Accent };
            var t = new Label { Text = title, Font = Ui.Title, ForeColor = Ui.Ink, AutoSize = false, AutoEllipsis = true, Location = new Point(left, Ui.Px(12)), Size = new Size(inner, Ui.Px(28)) };
            var b = new Label { Text = body, Font = Ui.Small, ForeColor = Ui.Ink, AutoSize = false, AutoEllipsis = true, Location = new Point(left, Ui.Px(42)), Size = new Size(inner, bodyH) };
            Controls.Add(bar); Controls.Add(t); Controls.Add(b);
            bodyLabel = b;
            int y = Ui.Px(42) + bodyH + Ui.Px(6);
            if (cancel != null)
            {
                var c = Link("취소", false, left, y);
                c.LinkClicked += delegate
                {
                    c.Enabled = false;
                    c.Text = "지금 파일까지 하고 멈춰요…";
                    this.cancel();
                };
                y += Ui.Px(24);
            }

            int x = left;
            if (open != null)
            {
                var o = Link("열기", true, x, y);
                o.LinkClicked += delegate
                {
                    try { Process.Start(new ProcessStartInfo(open) { UseShellExecute = true }); } catch { }
                    Close();
                };
                x = o.Right + Ui.Px(18);
            }
            if (reveal != null)
            {
                var f = Link("폴더에서 보기", open == null, x, y);
                f.LinkClicked += delegate
                {
                    try { Process.Start("explorer.exe", "/select,\"" + reveal + "\""); } catch { }
                    Close();
                };
            }
            if (open != null || reveal != null) y += Ui.Px(24);
            Size = new Size(w, y + Ui.Px(12));

            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Width - Ui.Px(16), wa.Bottom - Height - Ui.Px(16));

            Click += delegate { Close(); };
            t.Click += delegate { Close(); };
            b.Click += delegate { Close(); };
            // 문제가 있으면 더 오래 보여 주고, 마우스를 올리면 기다린다
            timer.Interval = bad ? 15000 : 8000;
            timer.Tick += delegate
            {
                if (Bounds.Contains(Cursor.Position)) return;
                timer.Stop(); Close();
            };
            if (!busy) Shown += delegate { timer.Start(); };
        }

        LinkLabel Link(string text, bool strong, int x, int y)
        {
            var l = new LinkLabel
            {
                Text = text, Font = strong ? Ui.SmallBold : Ui.Small, AutoSize = true, Location = new Point(x, y),
                LinkColor = Ui.Accent, ActiveLinkColor = Ui.Accent, LinkBehavior = LinkBehavior.HoverUnderline
            };
            Controls.Add(l);
            return l;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
    }

    /// 보내기 메뉴로 왔을 때: 보이지 않는 창이 커서 옆에 메뉴를 띄운다
    sealed class MenuHost : Form
    {
        readonly IList<string> files;
        bool picked;

        public MenuHost(IList<string> files)
        {
            this.files = files;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(1, 1);
            Location = Cursor.Position;
            Opacity = 0;
            Shown += delegate { Popup(); };
        }

        void Popup()
        {
            Activate();
            var m = Ui.Menu(files, delegate (string id)
            {
                picked = true;
                Ui.RunWithToast(id, files, delegate { Close(); });
            });
            // 메뉴는 항목의 Click보다 먼저 닫힌다. 바로 창을 닫으면 프로그램이 끝나 일하던 스레드도 같이 멈추므로,
            // 잠깐 기다렸다가 아무것도 고르지 않았을 때만 닫는다.
            m.Closed += delegate
            {
                var wait = new System.Windows.Forms.Timer { Interval = 400 };
                wait.Tick += delegate { wait.Stop(); wait.Dispose(); if (!picked) Close(); };
                wait.Start();
            };
            m.Show(Cursor.Position);
        }
    }

    /// 파일을 놓는 창
    sealed class DropWindow : Form
    {
        readonly Label hint;
        readonly Button installBtn;
        readonly Label note;
        readonly LinkLabel update;
        Updater.Info found;

        const string HintReady = "여기에 파일이나 폴더를 끌어다 놓으세요.\nPDF로 · 그림 용량 줄이기 · ZIP 묶기·풀기\n(복사한 파일은 Ctrl+V)";
        const string HintFirst = "처음이면 아래 주황 단추부터 눌러요.\n탐색기에서 오른쪽 클릭 → 보내기 → 툭\n\n지금 바로 쓰려면 여기에 파일을 놓으세요.";

        void CheckUpdate(bool asked)
        {
            update.Text = "확인하는 중…";
            var ui = SynchronizationContext.Current;
            new Thread(delegate ()
            {
                Updater.Info info = null; string problem = null;
                try { info = Updater.Check(); }
                catch (Exception ex) { problem = ex.Message; }
                ui.Post(delegate
                {
                    found = info;
                    if (info != null)
                    {
                        update.Text = "새 버전 " + info.Version + " 받기";
                        update.LinkColor = Ui.Accent;
                    }
                    else
                    {
                        update.Text = problem == null ? "지금이 최신 버전이에요" : "새 버전을 확인하지 못했어요";
                        if (asked && problem != null) MessageBox.Show(this, "인터넷 연결을 확인하고 다시 해 보세요.\n(" + problem + ")", AppInfo.Name);
                    }
                }, null);
            }) { IsBackground = true }.Start();
        }

        void ApplyUpdate()
        {
            var info = found;
            string msg = "툭 " + info.Version + "으로 바꿀까요?" + (info.Notes.Length > 0 ? "\n\n" + info.Notes : "");
            if (MessageBox.Show(this, msg, AppInfo.Name, MessageBoxButtons.OKCancel) != DialogResult.OK) return;
            update.Text = "받는 중…";
            update.Enabled = false;
            var ui = SynchronizationContext.Current;
            new Thread(delegate ()
            {
                string exe = null, problem = null;
                try { exe = Updater.Apply(info, delegate (double f) { ui.Post(delegate { update.Text = "받는 중… " + (int)(f * 100) + "%"; }, null); }); }
                catch (Exception ex) { problem = ex.Message; }
                ui.Post(delegate
                {
                    if (problem != null)
                    {
                        update.Enabled = true;
                        update.Text = "새 버전 " + info.Version + " 받기";
                        MessageBox.Show(this, "바꾸지 못했어요: " + problem, AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                    try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) }); } catch { }
                    Application.Exit();
                }, null);
            }) { IsBackground = true }.Start();
        }

        public DropWindow()
        {
            Text = AppInfo.Name + " " + AppInfo.Version;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = Ui.S(380, 296);
            BackColor = Ui.Paper;
            AllowDrop = true;
            TopMost = true;
            KeyPreview = true;

            var title = new Label { Text = "툭 놓으면 끝", Font = new Font("맑은 고딕", 18f, FontStyle.Bold), ForeColor = Ui.Ink, AutoSize = true, Location = Ui.P(24, 20) };
            hint = new Label
            {
                Font = Ui.Body, ForeColor = Ui.Ink, AutoSize = false, TextAlign = ContentAlignment.MiddleCenter,
                Location = Ui.P(24, 70), Size = Ui.S(332, 122), BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White
            };
            installBtn = new Button { Font = Ui.Body, Location = Ui.P(24, 206), Size = Ui.S(200, 38), UseVisualStyleBackColor = false };
            note = new Label { Text = "결과는 원본 옆에\n새 파일로 생겨요", Font = Ui.Small, ForeColor = Color.Gray, AutoSize = true, Location = Ui.P(236, 209) };
            update = new LinkLabel { Text = "새 버전 확인", Font = Ui.Small, AutoSize = true, Location = Ui.P(24, 264), LinkColor = Color.Gray };
            var site = new LinkLabel { Text = "웹에서 쓰기 · 소개", Font = Ui.Small, AutoSize = true, LinkColor = Color.Gray };
            Controls.Add(title); Controls.Add(hint); Controls.Add(installBtn); Controls.Add(note); Controls.Add(update); Controls.Add(site);
            site.Location = new Point(ClientSize.Width - Ui.Px(24) - site.PreferredWidth, Ui.Px(264));
            RefreshInstall();
            installBtn.Click += delegate { ToggleInstall(); };
            update.LinkClicked += delegate { if (found != null) ApplyUpdate(); else CheckUpdate(true); };
            site.LinkClicked += delegate { try { Process.Start(new ProcessStartInfo(Updater.Site) { UseShellExecute = true }); } catch { } };
            // 하루 한 번만, 창이 뜬 뒤 조용히 확인한다
            Shown += delegate { if (!Updater.CheckedToday) CheckUpdate(false); };

            DragEnter += delegate (object s, DragEventArgs e)
            {
                e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
                if (e.Effect != DragDropEffects.None) { hint.BackColor = Ui.Soft; hint.Text = "놓으면 할 일을 골라요"; }
            };
            DragLeave += delegate { RefreshInstall(); };
            DragDrop += delegate (object s, DragEventArgs e)
            {
                RefreshInstall();
                var dropped = e.Data.GetData(DataFormats.FileDrop) as string[];
                if (dropped == null || dropped.Length == 0) return;
                var list = dropped.ToList();
                BeginInvoke(new Action(delegate { Activate(); ShowMenu(list, Cursor.Position); }));
            };
            KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) { Close(); return; }
                if (e.Control && e.KeyCode == Keys.V)
                {
                    e.Handled = true;
                    if (!Clipboard.ContainsFileDropList())
                    {
                        MessageBox.Show(this, "복사한 파일이 없어요. 탐색기에서 파일을 고르고 Ctrl+C를 누른 뒤 다시 해 보세요.", AppInfo.Name);
                        return;
                    }
                    var list = Clipboard.GetFileDropList().Cast<string>().ToList();
                    ShowMenu(list, hint.PointToScreen(new Point(hint.Width / 3, hint.Height / 2)));
                }
            };
        }

        void ShowMenu(List<string> list, Point at)
        {
            var m = Ui.Menu(list, delegate (string id) { Ui.RunWithToast(id, list, null); });
            m.Show(at);
        }

        void RefreshInstall()
        {
            bool installed = Installer.Installed;
            installBtn.Text = installed ? "보내기 메뉴에서 빼기" : "보내기 메뉴에 넣기";
            // 처음 쓸 때는 할 일을 눈에 띄게
            installBtn.FlatStyle = installed ? FlatStyle.System : FlatStyle.Flat;
            installBtn.BackColor = installed ? SystemColors.Control : Ui.Accent;
            installBtn.ForeColor = installed ? SystemColors.ControlText : Color.White;
            installBtn.Font = installed ? Ui.Body : new Font(Ui.Body, FontStyle.Bold);
            installBtn.FlatAppearance.BorderSize = 0;
            hint.Text = installed ? HintReady : HintFirst;
            hint.BackColor = Color.White;
        }

        void ToggleInstall()
        {
            try
            {
                if (Installer.Installed)
                {
                    Installer.Uninstall();
                    MessageBox.Show(this, "보내기 메뉴와 시작 메뉴에서 뺐어요.", AppInfo.Name);
                }
                else
                {
                    Installer.Install();
                    MessageBox.Show(this, "넣었어요. 파일을 오른쪽 클릭 → 보내기 → 툭 을 눌러 보세요.\n(윈도우 11은 '더 많은 옵션 표시'를 먼저 눌러요.)", AppInfo.Name);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "하지 못했어요: " + Jobs.Friendly(ex), AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            RefreshInstall();
        }
    }
}
