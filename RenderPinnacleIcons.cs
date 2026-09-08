using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public class PinnacleIconRenderer
{
    // The EXACT Centras "c" geometry measured from official logo
    // Height = h
    // Width = 0.58 * h
    // Thickness = 0.138 * h
    // Corner Radius = 0.28 * h
    public static GraphicsPath CreateExactCentrasC(float cx, float cy, float height)
    {
        GraphicsPath path = new GraphicsPath();

        float h = height;
        float w = h * 0.58f;
        float t = h * 0.138f;
        float rOut = h * 0.28f;
        float rIn = rOut - t;

        float left = cx - w / 2f;
        float right = left + w;
        float top = cy - h / 2f;
        float bottom = top + h;

        float dOut = rOut * 2f;
        float dIn = rIn * 2f;

        path.AddLine(right, top, left + rOut, top);
        path.AddArc(left, top, dOut, dOut, 270, -90);
        path.AddLine(left, top + rOut, left, bottom - rOut);
        path.AddArc(left, bottom - dOut, dOut, dOut, 180, -90);
        path.AddLine(left + rOut, bottom, right, bottom);
        path.AddLine(right, bottom, right, bottom - t);
        path.AddLine(right, bottom - t, left + t + rIn, bottom - t);
        path.AddArc(left + t, bottom - t - dIn, dIn, dIn, 90, 90);
        path.AddLine(left + t, bottom - t - rIn, left + t, top + t + rIn);
        path.AddArc(left + t, top + t, dIn, dIn, 180, 90);
        path.AddLine(left + t + rIn, top + t, right, top + t);
        path.CloseFigure();

        return path;
    }

    // High precision rounded squircle
    public static GraphicsPath CreateSquircle(float x, float y, float size, float r)
    {
        GraphicsPath path = new GraphicsPath();
        float d = r * 2f;
        path.AddArc(x, y, d, d, 180, 90);
        path.AddArc(x + size - d, y, d, d, 270, 90);
        path.AddArc(x + size - d, y + size - d, d, d, 0, 90);
        path.AddArc(x, y + size - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // Elegant Frosted Glass Dialogue Cloud with sleek modern curved tail
    public static GraphicsPath CreateLuxuryDialogueCloud(float cx, float cy, float width, float height, float radius)
    {
        GraphicsPath path = new GraphicsPath();
        float x = cx - width / 2f;
        float y = cy - height / 2f;
        float d = radius * 2f;

        // Top-left arc
        path.AddArc(x, y, d, d, 180, 90);
        // Top-right arc
        path.AddArc(x + width - d, y, d, d, 270, 90);
        // Bottom-right arc
        path.AddArc(x + width - d, y + height - d, d, d, 0, 90);

        // Bottom edge towards speech tail
        float tailBaseRight = x + radius * 1.6f;
        float tailBaseLeft = x + radius * 0.75f;
        path.AddLine(x + width - radius, y + height, tailBaseRight, y + height);

        // Subtle, elegant curved dialogue tail with smooth rounded tip
        float tipX = x + radius * 0.2f;
        float tipY = y + height + 52f;

        path.AddBezier(
            tailBaseRight, y + height,
            tailBaseRight - 30f, y + height + 24f,
            tipX + 45f, tipY - 4f,
            tipX, tipY
        );

        path.AddBezier(
            tipX, tipY,
            tipX + 15f, tipY - 22f,
            tailBaseLeft - 15f, y + height + 15f,
            tailBaseLeft, y + height
        );

        // Bottom-left arc
        path.AddArc(x, y + height - d, d, d, 90, 90);

        path.CloseFigure();
        return path;
    }

    public static ColorBlend GetCentrasSpectrum()
    {
        ColorBlend blend = new ColorBlend();
        blend.Colors = new Color[] {
            Color.FromArgb(255, 236, 142, 224), // 0.00: Soft Holographic Orchid
            Color.FromArgb(255, 192, 120, 238), // 0.20: Amethyst Lilac
            Color.FromArgb(255, 124, 68, 234),  // 0.45: Deep Centras Violet
            Color.FromArgb(255, 42, 114, 238),  // 0.75: Royal Azure
            Color.FromArgb(255, 0, 218, 255)    // 1.00: Electric Neon Cyan
        };
        blend.Positions = new float[] { 0.0f, 0.20f, 0.45f, 0.75f, 1.0f };
        return blend;
    }

    // MASTERPIECE 1: "Centras Fluent Glass Enterprise"
    // Symmetrical royal squircle + Floating Frosted Glass Dialogue Cloud + Optically-centered Holographic Centras "c" + Glowing Presence Jewel
    public static Bitmap RenderFluentGlassEnterprise(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            float scale = size / 1024f;
            float sqX = 72f * scale;
            float sqY = 65f * scale;
            float sqSize = 880f * scale;
            float sqR = 205f * scale;

            // 1. Deep multi-layer diffused drop shadow with Centras purple/indigo aura
            for (int i = 8; i >= 1; i--)
            {
                float sOff = (16f + i * 4.5f) * scale;
                float sSpr = (i * 3.5f) * scale;
                int alpha = (int)(20 - i * 2.2f);
                if (alpha < 1) alpha = 1;

                using (GraphicsPath sp = CreateSquircle(sqX - sSpr, sqY + sOff - sSpr, sqSize + sSpr * 2, sqR + sSpr))
                {
                    using (SolidBrush sb = new SolidBrush(Color.FromArgb(alpha, 55, 25, 130)))
                    {
                        g.FillPath(sb, sp);
                    }
                }
            }

            // 2. Base Squircle: Rich Centras Multidimensional Spectrum
            using (GraphicsPath squircle = CreateSquircle(sqX, sqY, sqSize, sqR))
            {
                using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                    new PointF(sqX, sqY),
                    new PointF(sqX + sqSize, sqY + sqSize),
                    Color.Magenta, Color.Cyan))
                {
                    bgBrush.InterpolationColors = GetCentrasSpectrum();
                    g.FillPath(bgBrush, squircle);
                }

                // 3D Polished Bevel Rim along top and left
                using (LinearGradientBrush rimBrush = new LinearGradientBrush(
                    new PointF(sqX, sqY),
                    new PointF(sqX + sqSize, sqY + sqSize),
                    Color.FromArgb(160, 255, 255, 255),
                    Color.FromArgb(10, 255, 255, 255)))
                {
                    using (Pen rimPen = new Pen(rimBrush, 3.5f * scale))
                    {
                        g.DrawPath(rimPen, squircle);
                    }
                }

                // 3. Floating Frosted 3D Glass Dialogue Cloud
                float cloudW = 570f * scale;
                float cloudH = 540f * scale;
                float cloudCX = 512f * scale;
                float cloudCY = 485f * scale;
                float cloudR = 140f * scale;

                // Cloud ambient drop shadow onto squircle
                for (int s = 6; s >= 1; s--)
                {
                    float sOff = (10f + s * 4f) * scale;
                    float sSpr = (s * 2.5f) * scale;
                    int sAlpha = (int)(22 - s * 3.2f);
                    if (sAlpha < 1) sAlpha = 1;

                    using (GraphicsPath cloudShadow = CreateLuxuryDialogueCloud(
                        cloudCX, cloudCY + sOff, cloudW + sSpr * 2, cloudH + sSpr * 2, cloudR + sSpr))
                    {
                        using (SolidBrush csb = new SolidBrush(Color.FromArgb(sAlpha, 25, 15, 60)))
                        {
                            g.FillPath(csb, cloudShadow);
                        }
                    }
                }

                // Cloud Body: Frosted Liquid Crystal Glass
                using (GraphicsPath cloud = CreateLuxuryDialogueCloud(cloudCX, cloudCY, cloudW, cloudH, cloudR))
                {
                    // Translucent pearlescent glass fill
                    using (LinearGradientBrush glassBrush = new LinearGradientBrush(
                        new PointF(cloudCX - cloudW / 2f, cloudCY - cloudH / 2f),
                        new PointF(cloudCX + cloudW / 2f, cloudCY + cloudH / 2f + 50f * scale),
                        Color.FromArgb(250, 255, 255, 255),
                        Color.FromArgb(215, 242, 250, 255)))
                    {
                        g.FillPath(glassBrush, cloud);
                    }

                    // Glass Specular Gloss Arc (diagonal curved sheen across top-left)
                    GraphicsState state = g.Save();
                    g.SetClip(cloud);
                    using (GraphicsPath glossPath = new GraphicsPath())
                    {
                        glossPath.AddEllipse(
                            cloudCX - cloudW * 0.6f, cloudCY - cloudH * 0.9f,
                            cloudW * 1.15f, cloudH * 0.95f);
                        using (LinearGradientBrush glossBrush = new LinearGradientBrush(
                            new PointF(cloudCX - cloudW / 2f, cloudCY - cloudH / 2f),
                            new PointF(cloudCX, cloudCY + cloudH * 0.2f),
                            Color.FromArgb(120, 255, 255, 255),
                            Color.FromArgb(0, 255, 255, 255)))
                        {
                            g.FillPath(glossBrush, glossPath);
                        }
                    }
                    g.Restore(state);

                    // Laser-cut glass edge rim highlight
                    using (LinearGradientBrush glassRim = new LinearGradientBrush(
                        new PointF(cloudCX - cloudW / 2f, cloudCY - cloudH / 2f),
                        new PointF(cloudCX + cloudW / 2f, cloudCY + cloudH / 2f),
                        Color.FromArgb(240, 255, 255, 255),
                        Color.FromArgb(90, 180, 215, 255)))
                    {
                        using (Pen glassPen = new Pen(glassRim, 2.5f * scale))
                        {
                            g.DrawPath(glassPen, cloud);
                        }
                    }
                }

                // 4. The Centras "c" Monogram in 3D Liquid Holographic Foil
                // Optically centered inside the cloud: shifted slightly right to account for open aperture
                float cH = 345f * scale;
                float cW = cH * 0.58f;
                float cCX = (cloudCX - 12f * scale) + (cW * 0.12f); // Optical centering adjustment!
                float cCY = cloudCY - 10f * scale;

                // 3D Extrusion Shadow under "c"
                for (int d = 4; d >= 1; d--)
                {
                    using (GraphicsPath cShadow = CreateExactCentrasC(cCX, cCY + (d * 2.2f) * scale, cH))
                    {
                        int dAlpha = (int)(26 - d * 5.5f);
                        if (dAlpha < 1) dAlpha = 1;
                        using (SolidBrush csb = new SolidBrush(Color.FromArgb(dAlpha, 35, 20, 80)))
                        {
                            g.FillPath(csb, cShadow);
                        }
                    }
                }

                // Centras Monogram Fill: Liquid Centras Spectrum
                using (GraphicsPath cPath = CreateExactCentrasC(cCX, cCY, cH))
                {
                    using (LinearGradientBrush cBrush = new LinearGradientBrush(
                        new PointF(cCX - cW / 2f, cCY),
                        new PointF(cCX + cW / 2f, cCY),
                        Color.Magenta, Color.Cyan))
                    {
                        cBrush.InterpolationColors = GetCentrasSpectrum();
                        g.FillPath(cBrush, cPath);
                    }

                    // 3D Specular Bevel Highlight along the contour
                    using (LinearGradientBrush cBevel = new LinearGradientBrush(
                        new PointF(cCX, cCY - cH / 2f),
                        new PointF(cCX, cCY + cH / 2f),
                        Color.FromArgb(190, 255, 255, 255),
                        Color.FromArgb(30, 255, 255, 255)))
                    {
                        using (Pen cPen = new Pen(cBevel, 2.0f * scale))
                        {
                            g.DrawPath(cPen, cPath);
                        }
                    }
                }

                // 5. Active Presence Jewel (Cyan Neon Crystal nestled in the "c" aperture)
                float jewelX = cCX + cW / 2f + 32f * scale;
                float jewelY = cCY;
                float jewelR = 24f * scale;

                // Radial neon bloom
                using (GraphicsPath bloomPath = new GraphicsPath())
                {
                    bloomPath.AddEllipse(jewelX - jewelR * 2.2f, jewelY - jewelR * 2.2f, jewelR * 4.4f, jewelR * 4.4f);
                    using (PathGradientBrush pgb = new PathGradientBrush(bloomPath))
                    {
                        pgb.CenterColor = Color.FromArgb(140, 0, 229, 255);
                        pgb.SurroundColors = new Color[] { Color.FromArgb(0, 0, 229, 255) };
                        g.FillPath(pgb, bloomPath);
                    }
                }

                // Core 3D Spherical Jewel
                using (GraphicsPath jewelPath = new GraphicsPath())
                {
                    jewelPath.AddEllipse(jewelX - jewelR, jewelY - jewelR, jewelR * 2, jewelR * 2);
                    using (LinearGradientBrush jewelBrush = new LinearGradientBrush(
                        new PointF(jewelX - jewelR * 0.5f, jewelY - jewelR * 0.5f),
                        new PointF(jewelX + jewelR, jewelY + jewelR),
                        Color.FromArgb(255, 200, 248, 255),
                        Color.FromArgb(255, 0, 200, 240)))
                    {
                        g.FillPath(jewelBrush, jewelPath);
                    }

                    // Jewel pin-point reflection glint
                    using (SolidBrush glintBrush = new SolidBrush(Color.FromArgb(245, 255, 255, 255)))
                    {
                        g.FillEllipse(glintBrush, jewelX - jewelR * 0.45f, jewelY - jewelR * 0.45f, jewelR * 0.6f, jewelR * 0.45f);
                    }
                }
            }
        }
        return bmp;
    }

    // MASTERPIECE 2: "Centras Pure Monogram Jewel" (The Clean Apple / Linear / Raycast Style)
    // Symmetrical royal squircle + Large 3D Frosted White Pearl Centras "c" + Subtle 3D Dialogue Wave
    public static Bitmap RenderPureMonogramJewel(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            float scale = size / 1024f;
            float sqX = 72f * scale;
            float sqY = 65f * scale;
            float sqSize = 880f * scale;
            float sqR = 205f * scale;

            // Ambient drop shadow
            for (int i = 8; i >= 1; i--)
            {
                float sOff = (16f + i * 4.5f) * scale;
                float sSpr = (i * 3.5f) * scale;
                int alpha = (int)(20 - i * 2.2f);
                if (alpha < 1) alpha = 1;

                using (GraphicsPath sp = CreateSquircle(sqX - sSpr, sqY + sOff - sSpr, sqSize + sSpr * 2, sqR + sSpr))
                {
                    using (SolidBrush sb = new SolidBrush(Color.FromArgb(alpha, 55, 25, 130)))
                    {
                        g.FillPath(sb, sp);
                    }
                }
            }

            // Squircle Body: Centras Multidimensional Spectrum
            using (GraphicsPath squircle = CreateSquircle(sqX, sqY, sqSize, sqR))
            {
                using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                    new PointF(sqX, sqY),
                    new PointF(sqX + sqSize, sqY + sqSize),
                    Color.Magenta, Color.Cyan))
                {
                    bgBrush.InterpolationColors = GetCentrasSpectrum();
                    g.FillPath(bgBrush, squircle);
                }

                // Top rim bevel
                using (LinearGradientBrush rimBrush = new LinearGradientBrush(
                    new PointF(sqX, sqY),
                    new PointF(sqX + sqSize, sqY + sqSize),
                    Color.FromArgb(170, 255, 255, 255),
                    Color.FromArgb(15, 255, 255, 255)))
                {
                    using (Pen rimPen = new Pen(rimBrush, 3.5f * scale))
                    {
                        g.DrawPath(rimPen, squircle);
                    }
                }

                // Soft ambient surface gloss
                GraphicsState state = g.Save();
                g.SetClip(squircle);
                using (GraphicsPath glossArc = new GraphicsPath())
                {
                    glossArc.AddEllipse(sqX - 100f * scale, sqY - 260f * scale, sqSize * 1.25f, sqSize * 0.95f);
                    using (LinearGradientBrush glossBrush = new LinearGradientBrush(
                        new PointF(sqX, sqY),
                        new PointF(sqX, sqY + sqSize * 0.55f),
                        Color.FromArgb(70, 255, 255, 255),
                        Color.FromArgb(0, 255, 255, 255)))
                    {
                        g.FillPath(glossBrush, glossArc);
                    }
                }
                g.Restore(state);
            }

            // Hero Emblem: 3D Frosted White Pearl Centras "c" Monogram
            // Size: 500px height (bold, authoritative, unmistakable branding)
            float cH = 500f * scale;
            float cW = cH * 0.58f;
            float cCX = 512f * scale + (cW * 0.12f); // Optical centering
            float cCY = 505f * scale;

            // Multi-pass diffused drop shadow underneath monogram
            for (int s = 6; s >= 1; s--)
            {
                using (GraphicsPath cShadow = CreateExactCentrasC(cCX, cCY + (s * 3.8f) * scale, cH))
                {
                    int sAlpha = (int)(26 - s * 4f);
                    if (sAlpha < 1) sAlpha = 1;
                    using (SolidBrush csb = new SolidBrush(Color.FromArgb(sAlpha, 25, 15, 65)))
                    {
                        g.FillPath(csb, cShadow);
                    }
                }
            }

            // Monogram Body: Pure Frosted White Titanium / Pearl Glass
            using (GraphicsPath cPath = CreateExactCentrasC(cCX, cCY, cH))
            {
                using (LinearGradientBrush cBrush = new LinearGradientBrush(
                    new PointF(cCX, cCY - cH / 2f),
                    new PointF(cCX, cCY + cH / 2f),
                    Color.FromArgb(255, 255, 255, 255),
                    Color.FromArgb(255, 238, 244, 255)))
                {
                    g.FillPath(cBrush, cPath);
                }

                // 3D Polished Bevel Highlight along all edges
                using (LinearGradientBrush cRim = new LinearGradientBrush(
                    new PointF(cCX, cCY - cH / 2f),
                    new PointF(cCX, cCY + cH / 2f),
                    Color.FromArgb(255, 255, 255, 255),
                    Color.FromArgb(130, 200, 220, 245)))
                {
                    using (Pen cPen = new Pen(cRim, 2.8f * scale))
                    {
                        g.DrawPath(cPen, cPath);
                    }
                }
            }

            // Presence / Communication Jewel in the "c" aperture
            float jewelX = cCX + cW / 2f + 45f * scale;
            float jewelY = cCY;
            float jewelR = 34f * scale;

            // Radial neon cyan bloom
            using (GraphicsPath bloomPath = new GraphicsPath())
            {
                bloomPath.AddEllipse(jewelX - jewelR * 2.4f, jewelY - jewelR * 2.4f, jewelR * 4.8f, jewelR * 4.8f);
                using (PathGradientBrush pgb = new PathGradientBrush(bloomPath))
                {
                    pgb.CenterColor = Color.FromArgb(150, 0, 229, 255);
                    pgb.SurroundColors = new Color[] { Color.FromArgb(0, 0, 229, 255) };
                    g.FillPath(pgb, bloomPath);
                }
            }

            // 3D Spherical Cyan Pearl
            using (GraphicsPath jewelPath = new GraphicsPath())
            {
                jewelPath.AddEllipse(jewelX - jewelR, jewelY - jewelR, jewelR * 2, jewelR * 2);
                using (LinearGradientBrush jewelBrush = new LinearGradientBrush(
                    new PointF(jewelX - jewelR * 0.5f, jewelY - jewelR * 0.5f),
                    new PointF(jewelX + jewelR, jewelY + jewelR),
                    Color.FromArgb(255, 210, 250, 255),
                    Color.FromArgb(255, 0, 210, 245)))
                {
                    g.FillPath(jewelBrush, jewelPath);
                }

                using (SolidBrush glintBrush = new SolidBrush(Color.FromArgb(250, 255, 255, 255)))
                {
                    g.FillEllipse(glintBrush, jewelX - jewelR * 0.45f, jewelY - jewelR * 0.45f, jewelR * 0.6f, jewelR * 0.45f);
                }
            }
        }
        return bmp;
    }

    public static void Main(string[] args)
    {
        string outDir = @"C:\Users\user\.gemini\antigravity\brain\156792fa-7d1d-44e2-b6e8-37d33662ff76";
        if (args.Length > 0) outDir = args[0];

        Console.WriteLine("Rendering Pinnacle Luxury Icons...");

        // Masterpiece 1: Fluent Glass Enterprise (Dialogue cloud + Holographic Centras C + Jewel)
        using (Bitmap b1 = RenderFluentGlassEnterprise(1024))
        {
            string p1 = Path.Combine(outDir, "centras_pinnacle_fluent.png");
            b1.Save(p1, ImageFormat.Png);
            Console.WriteLine("Saved: " + p1);
        }

        // Masterpiece 2: Pure Monogram Jewel (Titanium Pearl C + Jewel on Centras Spectrum)
        using (Bitmap b2 = RenderPureMonogramJewel(1024))
        {
            string p2 = Path.Combine(outDir, "centras_pinnacle_monogram.png");
            b2.Save(p2, ImageFormat.Png);
            Console.WriteLine("Saved: " + p2);
        }

        Console.WriteLine("SUCCESS");
    }
}
