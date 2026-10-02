package com.flighttracker.app;

import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;

/**
 * Serves vector tiles of the bundled offline map straight out of the APK.
 * assets/www/public/map/tiles.bin holds all tiles back to back; tiles.idx is a sorted list of
 * [tileId, offset, length] uint32 triples (see scripts/build-basemap.mjs). Both are stored uncompressed,
 * so a tile is one positioned read with no unpacking.
 */
final class TilePack {
    private static final String BIN = "www/public/map/tiles.bin";
    private static final String IDX = "www/public/map/tiles.idx";
    private static final byte[] EMPTY = new byte[0];

    private final AssetManager assets;
    private int[] index;
    private AssetFileDescriptor binFd;
    private FileChannel channel;

    TilePack(AssetManager assets) {
        this.assets = assets;
    }

    private synchronized boolean open() throws IOException {
        if (index != null) return true;
        byte[] raw;
        try (InputStream in = assets.open(IDX)) {
            raw = readFully(in);
        }
        ByteBuffer buf = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        int[] idx = new int[raw.length / 4];
        buf.asIntBuffer().get(idx);
        binFd = assets.openFd(BIN); // requires the file to be stored uncompressed (noCompress)
        channel = new FileInputStream(binFd.getFileDescriptor()).getChannel();
        index = idx;
        return true;
    }

    /** Tile bytes; empty for tiles without data (open sea). Throws if the map package is missing. */
    byte[] get(int z, int x, int y) throws IOException {
        open();
        long id = ((1L << (2 * z)) - 1) / 3 + (long) y * (1L << z) + x;
        int lo = 0;
        int hi = index.length / 3 - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            long v = index[mid * 3] & 0xffffffffL;
            if (v == id) {
                long offset = index[mid * 3 + 1] & 0xffffffffL;
                int length = index[mid * 3 + 2];
                ByteBuffer out = ByteBuffer.allocate(length);
                long position = binFd.getStartOffset() + offset;
                while (out.hasRemaining()) {
                    int n = channel.read(out, position + out.position());
                    if (n < 0) break;
                }
                return out.array();
            }
            if (v < id) lo = mid + 1;
            else hi = mid - 1;
        }
        return EMPTY;
    }

    private static byte[] readFully(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[65536];
        int n;
        while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
        return buf.toByteArray();
    }
}
