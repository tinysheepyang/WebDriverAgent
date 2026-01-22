//
//  ContentView.swift
//  PhotoCompanion
//
//  Created by chenshiyang on 2026/1/2.
//

import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "photo.on.rectangle")
                .imageScale(.large)
                .foregroundStyle(.tint)
                .font(.system(size: 60))
            
            Text("Photo Companion Service")
                .font(.title)
                .fontWeight(.bold)
            
            Text("正在运行...")
                .font(.headline)
                .foregroundColor(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
