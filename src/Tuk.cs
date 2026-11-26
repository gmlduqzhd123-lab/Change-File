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

namespace Tuk
{
    static class AppInfo
    {
        public const string Name = "툭";
        public const string Version = "0.1.0";
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
                foreach (var p in job.Problems) Console.Error.WriteLine(p);
                return job.Problems.Count;
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
        static readonly string[] Images = { ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff" };
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
            if (img > 0) list.Add(new MenuChoice("shrink", "그림 용량 줄이기", "긴 쪽 1600픽셀 · JPG"));
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
    }

    static class Jobs
    {
        public static JobResult Run(string id, IList<string> files)
        {
            var r = new JobResult();
            try
            {
                switch (id)
                {
                    case "pdf": foreach (var f in files) Safe(r, f, delegate { ToPdf(r, f); }); break;
                    case "pdfall": Safe(r, files[0], delegate { ImagesToOnePdf(r, files.Where(Kinds.IsImage).ToList()); }); break;
                    case "shrink": foreach (var f in files.Where(Kinds.IsImage)) Safe(r, f, delegate { Shrink(r, f); }); break;
                    case "zip": Safe(r, files[0], delegate { r.Made.Add(Zipper.Pack(files)); }); break;
                    case "unzip": foreach (var f in files) Safe(r, f, delegate { r.Made.Add(Zipper.Unpack(f)); }); break;
                    default: r.Problems.Add("모르는 동작: " + id); break;
                }
            }
            catch (Exception ex) { r.Problems.Add(ex.Message); }
            return r;
        }

        static void Safe(JobResult r, string f, Action a)
        {
            try { a(); }
            catch (Exception ex)
            {
                var inner = ex is System.Reflection.TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
                r.Problems.Add(Path.GetFileName(f) + ": " + inner.Message);
                if (Environment.GetEnvironmentVariable("TUK_DEBUG") == "1") Console.Error.WriteLine(ex.ToString());
            }
        }

        static void ToPdf(JobResult r, string f)
        {
            if (!Kinds.ToPdf(f)) { r.Notes.Add(Path.GetFileName(f) + "은(는) PDF로 바꿀 수 없어서 건너뛰었어요."); return; }
            string outPath = Paths.Beside(f, "", ".pdf");
            if (Kinds.IsImage(f)) Pdf.FromImages(outPath, new List<string> { f });
            else Office.ToPdf(f, outPath);
            r.Made.Add(outPath);
        }

        static void ImagesToOnePdf(JobResult r, List<string> imgs)
        {
            string outPath = Paths.Beside(imgs[0], "_묶음", ".pdf");
            Pdf.FromImages(outPath, imgs);
            r.Made.Add(outPath);
        }

        static void Shrink(JobResult r, string f)
        {
            long before = new FileInfo(f).Length;
            byte[] jpg;
            using (var img = Pictures.LoadUpright(f)) jpg = Pictures.Jpeg(img, 1600, 80);
            if (jpg.Length >= before)
            {
                r.Notes.Add(Path.GetFileName(f) + "은(는) 이미 충분히 작아요.");
                return;
            }
            string outPath = Paths.Beside(f, "_줄임", ".jpg");
            File.WriteAllBytes(outPath, jpg);
            r.Made.Add(outPath);
            r.Notes.Add(Path.GetFileName(f) + ": " + Paths.Size(before) + " → " + Paths.Size(jpg.Length));
        }
    }

    static class Paths
    {
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
            Image img;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var src = Image.FromStream(fs))
            {
                img = new Bitmap(src);
                if (src.PropertyIdList.Contains(0x0112))
                {
                    int o = BitConverter.ToUInt16(src.GetPropertyItem(0x0112).Value, 0);
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
                        default: t = RotateFlipType.RotateNoneFlipNone; break;
                    }
                    img.RotateFlip(t);
                }
            }
            return img;
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
        const double A4W = 595.28, A4H = 841.89, Margin = 28;

        public static void FromImages(string outPath, IList<string> images)
        {
            string tmp = outPath + ".part";
            var offsets = new Dictionary<int, long>();
            int pageCount = images.Count;
            var kids = new List<int>();
            try
            {
                using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                {
                    var w = new PdfOut(fs);
                    w.Raw("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
                    offsets[1] = w.Pos; w.Raw("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
                    int next = 3;
                    foreach (var f in images)
                    {
                        byte[] jpg; int iw, ih;
                        using (var img = Pictures.LoadUpright(f))
                        {
                            jpg = Pictures.Jpeg(img, 0, 90);
                            iw = img.Width; ih = img.Height;
                        }
                        bool land = iw > ih;
                        double pw = land ? A4H : A4W, ph = land ? A4W : A4H;
                        double s = Math.Min((pw - 2 * Margin) / iw, (ph - 2 * Margin) / ih);
                        double dw = iw * s, dh = ih * s, x = (pw - dw) / 2, y = (ph - dh) / 2;

                        int imgId = next++, contentId = next++, pageId = next++;
                        offsets[imgId] = w.Pos;
                        w.Raw(imgId + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + iw + " /Height " + ih +
                              " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpg.Length + " >>\nstream\n");
                        w.Bytes(jpg);
                        w.Raw("\nendstream\nendobj\n");

                        string content = "q " + N(dw) + " 0 0 " + N(dh) + " " + N(x) + " " + N(y) + " cm /Im0 Do Q\n";
                        offsets[contentId] = w.Pos;
                        w.Raw(contentId + " 0 obj\n<< /Length " + content.Length + " >>\nstream\n" + content + "endstream\nendobj\n");

                        offsets[pageId] = w.Pos;
                        w.Raw(pageId + " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + N(pw) + " " + N(ph) + "] " +
                              "/Resources << /XObject << /Im0 " + imgId + " 0 R >> >> /Contents " + contentId + " 0 R >>\nendobj\n");
                        kids.Add(pageId);
                    }
                    offsets[2] = w.Pos;
                    w.Raw("2 0 obj\n<< /Type /Pages /Count " + pageCount + " /Kids [" + string.Join(" ", kids.Select(k => k + " 0 R")) + "] >>\nendobj\n");

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
        public static readonly Font Body = new Font("맑은 고딕", 10f);
        public static readonly Font Title = new Font("맑은 고딕", 13f, FontStyle.Bold);
        public static readonly Font Small = new Font("맑은 고딕", 8.5f);

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
                item.Click += delegate { chosen(choice.Id); };
                m.Items.Add(item);
                n++;
            }
            return m;
        }

        /// 일을 STA 스레드(오피스 COM에 필요)에서 하고, 끝나면 알림을 띄운다.
        public static void RunWithToast(string id, IList<string> files, Action done)
        {
            var label = Choices.For(files).Where(c => c.Id == id).Select(c => c.Label).FirstOrDefault() ?? id;
            var busy = new Toast(label + " 하는 중…", "잠시만 기다려 주세요.", null, false);
            busy.Show();
            var ui = SynchronizationContext.Current;
            var t = new Thread(delegate ()
            {
                var r = Jobs.Run(id, files);
                ui.Post(delegate
                {
                    busy.Close();
                    string title, body;
                    if (r.Made.Count > 0 && r.Problems.Count == 0) title = "다 됐어요 · " + label;
                    else if (r.Made.Count > 0) title = "일부만 됐어요 · " + label;
                    else title = "하지 못했어요 · " + label;
                    var lines = new List<string>();
                    if (r.Made.Count == 1) lines.Add(Path.GetFileName(r.Made[0]));
                    else if (r.Made.Count > 1) lines.Add(r.Made.Count + "개 만들었어요");
                    lines.AddRange(r.Notes.Take(2));
                    lines.AddRange(r.Problems.Take(2));
                    body = string.Join("\n", lines);
                    var toast = new Toast(title, body, r.Made.Count > 0 ? r.Made[0] : null, r.Made.Count == 0);
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

        public Toast(string title, string body, string reveal, bool bad)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Ui.Paper;
            Size = new Size(360, 120);
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Width - 16, wa.Bottom - Height - 16);
            Padding = new Padding(16);

            var bar = new Panel { Dock = DockStyle.Left, Width = 6, BackColor = bad ? Color.IndianRed : Ui.Accent };
            var t = new Label { Text = title, Font = Ui.Title, ForeColor = Ui.Ink, AutoSize = false, Location = new Point(22, 12), Size = new Size(320, 26) };
            var b = new Label { Text = body, Font = Ui.Small, ForeColor = Ui.Ink, AutoSize = false, Location = new Point(22, 40), Size = new Size(320, 48) };
            Controls.Add(bar); Controls.Add(t); Controls.Add(b);
            if (reveal != null)
            {
                var open = new LinkLabel { Text = "폴더에서 보기", Font = Ui.Small, AutoSize = true, Location = new Point(22, 92), LinkColor = Ui.Accent };
                open.LinkClicked += delegate
                {
                    try { Process.Start("explorer.exe", "/select,\"" + reveal + "\""); } catch { }
                    Close();
                };
                Controls.Add(open);
            }
            Click += delegate { Close(); };
            t.Click += delegate { Close(); };
            b.Click += delegate { Close(); };
            timer.Interval = 7000;
            timer.Tick += delegate { timer.Stop(); Close(); };
            Shown += delegate { if (!title.EndsWith("…")) timer.Start(); };
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
            m.Closed += delegate { if (!picked) BeginInvoke(new Action(Close)); };
            m.Show(Cursor.Position);
        }
    }

    /// 파일을 놓는 창
    sealed class DropWindow : Form
    {
        readonly Label hint;
        readonly Button installBtn;
        readonly LinkLabel update;
        Updater.Info found;

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
            ClientSize = new Size(380, 284);
            BackColor = Ui.Paper;
            AllowDrop = true;
            TopMost = true;

            var title = new Label { Text = "툭 놓으면 끝", Font = new Font("맑은 고딕", 18f, FontStyle.Bold), ForeColor = Ui.Ink, AutoSize = true, Location = new Point(24, 20) };
            hint = new Label
            {
                Text = "여기에 파일이나 폴더를 끌어다 놓으세요.\nPDF로 · 그림 용량 줄이기 · ZIP 묶기·풀기",
                Font = Ui.Body, ForeColor = Ui.Ink, AutoSize = false, TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(24, 70), Size = new Size(332, 110), BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White
            };
            installBtn = new Button { Font = Ui.Body, Location = new Point(24, 196), Size = new Size(200, 36), FlatStyle = FlatStyle.System };
            var note = new Label { Text = "결과는 원본 옆에\n새 파일로 생겨요", Font = Ui.Small, ForeColor = Color.Gray, AutoSize = true, Location = new Point(236, 198) };
            update = new LinkLabel { Text = "새 버전 확인", Font = Ui.Small, AutoSize = true, Location = new Point(24, 252), LinkColor = Color.Gray };
            var site = new LinkLabel { Text = "웹에서 쓰기 · 소개", Font = Ui.Small, AutoSize = true, Location = new Point(250, 252), LinkColor = Color.Gray };
            Controls.Add(title); Controls.Add(hint); Controls.Add(installBtn); Controls.Add(note); Controls.Add(update); Controls.Add(site);
            RefreshInstall();
            installBtn.Click += delegate { ToggleInstall(); };
            update.LinkClicked += delegate { if (found != null) ApplyUpdate(); else CheckUpdate(true); };
            site.LinkClicked += delegate { try { Process.Start(new ProcessStartInfo(Updater.Site) { UseShellExecute = true }); } catch { } };
            // 하루 한 번만, 창이 뜬 뒤 조용히 확인한다
            Shown += delegate { if (!Updater.CheckedToday) CheckUpdate(false); };

            DragEnter += delegate (object s, DragEventArgs e)
            {
                e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
                if (e.Effect != DragDropEffects.None) hint.BackColor = Color.FromArgb(255, 236, 224);
            };
            DragLeave += delegate { hint.BackColor = Color.White; };
            DragDrop += delegate (object s, DragEventArgs e)
            {
                hint.BackColor = Color.White;
                var dropped = e.Data.GetData(DataFormats.FileDrop) as string[];
                if (dropped == null || dropped.Length == 0) return;
                var list = dropped.ToList();
                BeginInvoke(new Action(delegate
                {
                    Activate();
                    var m = Ui.Menu(list, delegate (string id) { Ui.RunWithToast(id, list, null); });
                    m.Show(Cursor.Position);
                }));
            };
        }

        void RefreshInstall()
        {
            installBtn.Text = Installer.Installed ? "보내기 메뉴에서 빼기" : "보내기 메뉴에 넣기";
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
                MessageBox.Show(this, "하지 못했어요: " + ex.Message, AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            RefreshInstall();
        }
    }
}
