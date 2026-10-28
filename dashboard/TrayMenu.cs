using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

// Round the actual popup window, not the small office symbol in the tray icon.
public sealed class OfficeTrayMenu : ContextMenuStrip
{
    public OfficeTrayMenu()
    {
        BackColor = Color.FromArgb(250, 251, 250);
        DropShadowEnabled = false;
        Renderer = new RoundedRenderer();
    }

    private static GraphicsPath Outline(int width, int height, float inset)
    {
        const float diameter = 16;
        float right = width - inset, bottom = height - inset;
        var path = new GraphicsPath();
        path.AddArc(inset, inset, diameter, diameter, 180, 90);
        path.AddArc(right - diameter, inset, diameter, diameter, 270, 90);
        path.AddArc(right - diameter, bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(inset, bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void OnSizeChanged(System.EventArgs e)
    {
        base.OnSizeChanged(e);
        if (Width < 16 || Height < 16) return;
        using (var path = Outline(Width, Height, 0))
        {
            var previous = Region;
            Region = new Region(path);
            if (previous != null) previous.Dispose();
        }
    }

    private sealed class RoundedRenderer : ToolStripSystemRenderer
    {
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            // WinForms adds status padding to the row height but does not move
            // its text down. Use that extra height as space above the text.
            if (e.ToolStrip.Items.Count > 0 && e.Item == e.ToolStrip.Items[0])
            {
                var bounds = e.TextRectangle;
                bounds.Offset(0, 8);
                e.TextRectangle = bounds;
            }
            base.OnRenderItemText(e);
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            using (var brush = new SolidBrush(e.ToolStrip.BackColor))
                e.Graphics.FillRectangle(brush, e.ToolStrip.ClientRectangle);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var smoothing = e.Graphics.SmoothingMode;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Outline(e.ToolStrip.Width, e.ToolStrip.Height, 0.5f))
            using (var pen = new Pen(Color.FromArgb(205, 212, 208)))
                e.Graphics.DrawPath(pen, path);
            e.Graphics.SmoothingMode = smoothing;
        }
    }
}
