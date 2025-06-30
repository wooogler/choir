import * as fs from 'fs';
import * as path from 'path';

/**
 * 로컬 파일 저장 서비스
 */
export class FileStorageService {
  private static instance: FileStorageService;
  private outputDir: string;

  private constructor() {
    // 출력 디렉토리 설정 (프로젝트 루트의 output 폴더)
    this.outputDir = path.join(process.cwd(), 'output');
    this.ensureOutputDirectory();
  }

  public static getInstance(): FileStorageService {
    if (!FileStorageService.instance) {
      FileStorageService.instance = new FileStorageService();
    }
    return FileStorageService.instance;
  }

  /**
   * 출력 디렉토리가 존재하는지 확인하고 없으면 생성
   */
  private ensureOutputDirectory(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      console.log(`Created output directory: ${this.outputDir}`);
    }
  }

  /**
   * 마크다운 파일을 로컬에 저장
   */
  public saveMarkdownFile(
    fileName: string,
    content: string,
    subfolder?: string,
  ): Promise<{ success: boolean; filePath: string; message: string }> {
    return new Promise((resolve) => {
      try {
        // 파일 경로 구성
        const targetDir = subfolder ? path.join(this.outputDir, subfolder) : this.outputDir;

        // 서브폴더가 있으면 생성
        if (subfolder && !fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        // 파일명에 타임스탬프 추가하여 중복 방지
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFileName = path.parse(fileName).name;
        const extension = path.parse(fileName).ext || '.md';
        const finalFileName = `${baseFileName}_${timestamp}${extension}`;

        const filePath = path.join(targetDir, finalFileName);

        // 파일 저장
        fs.writeFileSync(filePath, content, 'utf8');

        console.log(`Markdown file saved to: ${filePath}`);

        resolve({
          success: true,
          filePath,
          message: `✅ File saved successfully: ${filePath}`,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Failed to save markdown file:', errorMessage);

        resolve({
          success: false,
          filePath: '',
          message: `❌ Failed to save file: ${errorMessage}`,
        });
      }
    });
  }

  /**
   * 새 섹션이 추가된 마크다운을 저장
   */
  public async saveNewSectionMarkdown(
    originalFileName: string,
    sectionTitle: string,
    content: string,
  ): Promise<{ success: boolean; filePath: string; message: string }> {
    const subfolder = 'new-sections';
    const fileName = `${originalFileName}_with_section_${sectionTitle.replace(/[^a-zA-Z0-9]/g, '_')}.md`;

    return this.saveMarkdownFile(fileName, content, subfolder);
  }

  /**
   * 저장된 파일 목록 조회
   */
  public getOutputDirectory(): string {
    return this.outputDir;
  }

  /**
   * 저장된 파일 목록 반환
   */
  public listSavedFiles(subfolder?: string): string[] {
    try {
      const targetDir = subfolder ? path.join(this.outputDir, subfolder) : this.outputDir;

      if (!fs.existsSync(targetDir)) {
        return [];
      }

      return fs
        .readdirSync(targetDir)
        .filter((file) => file.endsWith('.md'))
        .sort((a, b) => {
          const aPath = path.join(targetDir, a);
          const bPath = path.join(targetDir, b);
          return fs.statSync(bPath).mtime.getTime() - fs.statSync(aPath).mtime.getTime();
        });
    } catch (error) {
      console.error('Failed to list saved files:', error);
      return [];
    }
  }
}
