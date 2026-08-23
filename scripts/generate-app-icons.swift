// Generates the AgentRoom app icon artwork for the visionOS layered icon,
// the macOS app icon set, and the in-app home mark.
//
// Run from the repository root:
//   swift scripts/generate-app-icons.swift
//
// Design grounding: WWDC23 10076 "Design for spatial user interfaces"
// (docs/reference/apple-wwdc2023-10076-spatial-ui-index.json entries
// app-icons-layer-construction, app-icons-circular-mask-glass,
// app-icons-centering-opacity). The Meshy portal artwork is split into a
// full-bleed back plate, a restrained frame highlight, and a transparent
// foreground glyph. visionOS supplies the circular mask and gaze response.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let repoRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let visionLayerRoot = repoRoot.appendingPathComponent(
    "apps/visionos/AgentRoom/Assets.xcassets/AppIcon.solidimagestack")
let homeIconURL = repoRoot.appendingPathComponent(
    "apps/visionos/AgentRoom/Assets.xcassets/AgentRoomHomeIcon.imageset/AgentRoomHomeIcon.png")
let macIconRoot = repoRoot.appendingPathComponent(
    "apps/macos/AgentRoomMac/Assets.xcassets/AppIcon.appiconset")
let brandingRoot = repoRoot.appendingPathComponent("assets/branding")
let portalBackURL = brandingRoot.appendingPathComponent("AgentRoomSpatialPortalBack.png")
let portalFrontURL = brandingRoot.appendingPathComponent("AgentRoomSpatialPortalFront.png")

func rgba(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}

let backBottom = rgba(0.045, 0.08, 0.12)
let frameTint = rgba(0.74, 0.93, 0.96, 0.34)

func makeContext(size: Int) -> CGContext {
    guard
        let space = CGColorSpace(name: CGColorSpace.sRGB),
        let ctx = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
        fatalError("Could not create CGContext of size \(size)")
    }
    // Flip to a top-left origin so design coordinates read naturally.
    ctx.translateBy(x: 0, y: CGFloat(size))
    ctx.scaleBy(x: 1, y: -1)
    return ctx
}

func writePNG(_ ctx: CGContext, to url: URL) {
    // The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships without
    // apps/visionos. An output whose directory is not in this checkout is
    // skipped rather than created, so the generator refreshes the icons this
    // tree holds and nothing else.
    var isDirectory: ObjCBool = false
    let parent = url.deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: parent.path, isDirectory: &isDirectory), isDirectory.boolValue else {
        print("skipped \(url.path) (directory is not in this checkout)")
        return
    }
    guard
        let image = ctx.makeImage(),
        let destination = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else {
        fatalError("Could not create PNG destination for \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("Could not write \(url.path)")
    }
    print("wrote \(url.path)")
}

func loadPNG(at url: URL) -> CGImage {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fatalError("Could not load PNG at \(url.path)")
    }
    return image
}

func drawPNG(_ image: CGImage, in rect: CGRect, on ctx: CGContext) {
    ctx.saveGState()
    ctx.interpolationQuality = .high
    // The bitmap context uses a top-left design origin. Counter-flip imported
    // CGImages so their authored top edge stays at the top of the icon.
    ctx.translateBy(x: rect.minX, y: rect.maxY)
    ctx.scaleBy(
        x: rect.width / CGFloat(image.width),
        y: -rect.height / CGFloat(image.height))
    ctx.draw(
        image,
        in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    ctx.restoreGState()
}

// A single thin rounded-square outline: the spatial volume frame.
func drawFrame(_ ctx: CGContext, in rect: CGRect) {
    let side = rect.width * 0.547
    let frameRect = CGRect(
        x: rect.midX - side / 2, y: rect.midY - side / 2, width: side, height: side)
    let path = CGPath(
        roundedRect: frameRect,
        cornerWidth: side * 0.232,
        cornerHeight: side * 0.232,
        transform: nil)
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setLineWidth(rect.width * 0.0156)
    ctx.setStrokeColor(frameTint)
    ctx.strokePath()
    ctx.restoreGState()
}

func scaleRect(_ rect: CGRect, from sourceSize: CGFloat, into destination: CGRect) -> CGRect {
    CGRect(
        x: destination.minX + rect.minX / sourceSize * destination.width,
        y: destination.minY + rect.minY / sourceSize * destination.height,
        width: rect.width / sourceSize * destination.width,
        height: rect.height / sourceSize * destination.height)
}

// visionOS layered icon: 1024px squares with the detailed Meshy render kept
// in repo-owned source assets. The transparent foreground is drawn into the
// original portal chamber coordinates rather than allowed to fill the canvas.
let layerSize = 1024
let fullRect = CGRect(x: 0, y: 0, width: layerSize, height: layerSize)
let portalBack = loadPNG(at: portalBackURL)
let portalFront = loadPNG(at: portalFrontURL)
let portalFrontRect = CGRect(x: 262, y: 250, width: 500, height: 500)

let backCtx = makeContext(size: layerSize)
drawPNG(portalBack, in: fullRect, on: backCtx)
writePNG(
    backCtx,
    to: visionLayerRoot.appendingPathComponent(
        "Back.solidimagestacklayer/Content.imageset/AgentRoomIconBack.png"))

let middleCtx = makeContext(size: layerSize)
drawFrame(middleCtx, in: fullRect)
writePNG(
    middleCtx,
    to: visionLayerRoot.appendingPathComponent(
        "Middle.solidimagestacklayer/Content.imageset/AgentRoomIconMiddle.png"))

let frontCtx = makeContext(size: layerSize)
drawPNG(portalFront, in: portalFrontRect, on: frontCtx)
writePNG(
    frontCtx,
    to: visionLayerRoot.appendingPathComponent(
        "Front.solidimagestacklayer/Content.imageset/AgentRoomIconFront.png"))

// The in-app home mark uses the same complete composition. SwiftUI adds one
// finite entrance and light sweep; the artwork itself remains still.
let homeCtx = makeContext(size: layerSize)
drawPNG(portalBack, in: fullRect, on: homeCtx)
drawFrame(homeCtx, in: fullRect)
drawPNG(portalFront, in: portalFrontRect, on: homeCtx)
writePNG(homeCtx, to: homeIconURL)

// macOS icon: the same Meshy portal composite inside the standard centered squircle
// (824/1024 of the canvas) with transparent margins and a soft shadow.
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let ctx = makeContext(size: size)
    let canvas = CGFloat(size)
    let inset = canvas * 100 / 1024
    let iconRect = CGRect(
        x: inset, y: inset, width: canvas - inset * 2, height: canvas - inset * 2)
    let corner = iconRect.width * 185 / 824
    let macPortalFrontRect = scaleRect(
        portalFrontRect,
        from: CGFloat(layerSize),
        into: iconRect)
    let squircle = CGPath(
        roundedRect: iconRect, cornerWidth: corner, cornerHeight: corner, transform: nil)

    ctx.saveGState()
    ctx.setShadow(
        offset: CGSize(width: 0, height: -canvas * 0.01),
        blur: canvas * 0.025,
        color: rgba(0, 0, 0, 0.32))
    ctx.addPath(squircle)
    ctx.setFillColor(backBottom)
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(squircle)
    ctx.clip()
    drawPNG(portalBack, in: iconRect, on: ctx)
    drawFrame(ctx, in: iconRect)
    drawPNG(portalFront, in: macPortalFrontRect, on: ctx)
    ctx.restoreGState()

    writePNG(ctx, to: macIconRoot.appendingPathComponent("AgentRoomIcon-\(size).png"))
}
